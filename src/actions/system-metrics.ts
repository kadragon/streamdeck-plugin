import {
	action,
	SingletonAction,
	streamDeck,
	type DialAction,
	type DidReceiveSettingsEvent,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type KeyDownEvent,
	type KeyAction,
	type SendToPluginEvent,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import {
	createWindowsMetricsSampler,
	selectSystemMetric,
	UnsupportedSystemMetricsError,
	type SystemMetrics
} from "../metrics/windows";
import { isSystemMetricKind, stepSystemMetric, type SystemMetricKind } from "../metrics/types";
import {
	formatSystemMetric,
	formatSystemTemperature,
	renderSystemMonitor,
	systemHeaderLabel,
	systemMetricProgress,
	systemMonitorAccent,
	systemStatusLabel,
	type SystemMonitorFace
} from "../render";

const DEFAULT_REFRESH_SECONDS = 15;
const MIN_REFRESH_SECONDS = 5;
// One sample costs seconds of PowerShell and nvidia-smi work, so the slowest cadence is capped well
// below "never" while the fastest stays above the sample cost.
const MAX_REFRESH_SECONDS = 300;
const DEFAULT_METRIC: SystemMetricKind = "cpu";
const DEFAULT_GPU_INDEX = 0;
const DISK_DATA_SOURCE = "systemMonitorDisks";
const ALL_DISKS_OPTION: DataSourceOption = { label: "All fixed drives", value: "" };
/**
 * Rotation ticks that advance the metric by one.
 *
 * Stepping on accumulated ticks rather than on elapsed time makes a fast turn land on a metric the
 * user can predict from how far they turned, instead of on one decided by callback timing.
 */
const TICKS_PER_METRIC_STEP = 2;
const DIAL_LAYOUT = "layouts/system-monitor.json";

export type SystemMonitorSettings = {
	metric?: SystemMetricKind;
	gpuIndex?: number;
	/** Seconds between ticker refreshes; a Property Inspector select yields this as a string. */
	refreshSeconds?: number | string;
	/** Fixed drive the `disk` metric is scoped to; blank or absent means every fixed drive. */
	diskDrive?: string;
};

type DataSourceRequest = {
	event?: string;
	isRefresh?: boolean;
};

type DataSourceOption = {
	label: string;
	value: string;
	disabled?: boolean;
};

type SystemMonitorAction = KeyAction<SystemMonitorSettings> | DialAction<SystemMonitorSettings>;

/** Displays local Windows CPU, memory, storage, network, and NVIDIA readings on one key. */
@action({ UUID: "com.kadragon.aiusage.system-monitor" })
export class SystemMonitor extends SingletonAction<SystemMonitorSettings> {
	#ticker?: NodeJS.Timeout;
	#tickerIntervalMs?: number;
	readonly #settings = new Map<string, SystemMonitorSettings>();
	readonly #settingsRevision = new Map<string, number>();
	readonly #rotation = new Map<string, number>();
	readonly #sampler = createWindowsMetricsSampler();

	override async onWillAppear(ev: WillAppearEvent<SystemMonitorSettings>): Promise<void> {
		const revision = this.#setSettings(ev.action.id, ev.payload.settings);
		this.#syncTicker();
		await this.#refresh(ev.action, ev.payload.settings, revision);
	}

	override onWillDisappear(ev: WillDisappearEvent<SystemMonitorSettings>): void {
		this.#settings.delete(ev.action.id);
		this.#rotation.delete(ev.action.id);
		// The revision counter is deliberately kept: a context that reappears must not restart at a
		// value an in-flight render from the previous appearance could still match.
		if ([...this.actions].length === 0) {
			this.#stopTicker();
			return;
		}

		this.#syncTicker();
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SystemMonitorSettings>): Promise<void> {
		const revision = this.#setSettings(ev.action.id, ev.payload.settings);
		this.#syncTicker();
		await this.#refresh(ev.action, ev.payload.settings, revision);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SystemMonitorSettings>): Promise<void> {
		if (!isDataSourceRequest(ev.payload) || ev.payload.event !== DISK_DATA_SOURCE) {
			return;
		}

		// The aggregate entry is supplied here rather than as an <option> child, because a datasource
		// response replaces the child nodes of the select.
		let items: DataSourceOption[] = [ALL_DISKS_OPTION];
		try {
			const metrics = await this.#sampler.read(ev.payload.isRefresh === true, this.#effectiveIntervalMs());
			items = [ALL_DISKS_OPTION, ...metrics.disks.map((disk) => ({ label: disk.id, value: disk.id }))];
		} catch (err) {
			if (!(err instanceof UnsupportedSystemMetricsError)) {
				streamDeck.logger.error("failed to list fixed drives", err);
			}
		}

		try {
			await streamDeck.ui.sendToPropertyInspector({ event: DISK_DATA_SOURCE, items });
		} catch (err) {
			streamDeck.logger.error("failed to send fixed drive options", err);
		}
	}

	override async onKeyDown(_ev: KeyDownEvent<SystemMonitorSettings>): Promise<void> {
		// System Monitor is display-only; its ticker owns refreshes rather than key presses.
	}

	override onDialRotate(ev: DialRotateEvent<SystemMonitorSettings>): void {
		const steps = this.#accumulateRotation(ev.action.id, ev.payload.ticks);
		if (steps === 0) {
			return;
		}

		// The event payload still carries the settings from before the previous rotation, because
		// setSettings resolves when the message is sent rather than when the host has applied it. The
		// local map is updated synchronously, so a fast turn must step from there or every event in the
		// same round trip computes the same successor.
		const base = this.#settings.get(ev.action.id) ?? ev.payload.settings;

		// Each handler terminates its own promise chain: a rejected refresh must never surface as an
		// unhandled rejection in the SDK callback.
		this.#cycleMetric(ev.action, base, steps).catch((err) =>
			streamDeck.logger.error("failed to change system monitor metric", err)
		);
	}

	override onDialDown(_ev: DialDownEvent<SystemMonitorSettings>): void {
		this.#forceRefresh();
	}

	override onTouchTap(_ev: TouchTapEvent<SystemMonitorSettings>): void {
		this.#forceRefresh();
	}

	// Releasing the dial is not a separate gesture here; the press already refreshed.
	override onDialUp(_ev: DialUpEvent<SystemMonitorSettings>): void {}

	/** Refreshes every visible instance from one shared sample, optionally bypassing the interval cache. */
	async refreshAll(options: { force?: boolean } = {}): Promise<void> {
		const visible = [...this.actions].filter((candidate) => candidate.isKey() || candidate.isDial());
		if (visible.length === 0) {
			return;
		}
		const snapshots = visible.map((target) => ({
			target,
			settings: this.#settings.get(target.id) ?? {},
			revision: this.#settingsRevision.get(target.id) ?? 0
		}));

		let metrics: SystemMetrics | undefined;
		let diagnostic: "missing" | "unsupported" = "missing";
		try {
			metrics = await this.#sampler.read(options.force === true, this.#effectiveIntervalMs());
		} catch (err) {
			diagnostic = err instanceof UnsupportedSystemMetricsError ? "unsupported" : "missing";
			if (!(err instanceof UnsupportedSystemMetricsError)) {
				streamDeck.logger.error("failed to read Windows system metrics", err);
			}
		}

		await Promise.all(
			snapshots.map(({ target, settings, revision }) => this.#render(target, settings, metrics, diagnostic, revision))
		);
	}

	#forceRefresh(): void {
		this.refreshAll({ force: true }).catch((err) => streamDeck.logger.error("system monitor manual refresh failed", err));
	}

	#accumulateRotation(actionId: string, ticks: number): number {
		const { steps, remainder } = accumulateRotationSteps(this.#rotation.get(actionId) ?? 0, ticks);
		this.#rotation.set(actionId, remainder);
		return steps;
	}

	async #cycleMetric(target: SystemMonitorAction, settings: SystemMonitorSettings, steps: number): Promise<void> {
		const nextSettings: SystemMonitorSettings = {
			...settings,
			metric: stepSystemMetric(settings.metric ?? DEFAULT_METRIC, steps)
		};
		const revision = this.#setSettings(target.id, nextSettings);
		await target.setSettings(nextSettings);
		await this.#refresh(target, nextSettings, revision);
	}

	/** One ticker serves every instance, so the fastest configured key sets the cadence for all. */
	#effectiveIntervalMs(): number {
		return effectiveRefreshSeconds(this.#settings.values()) * 1_000;
	}

	/** (Re-)arms the shared ticker whenever the effective interval changes. */
	#syncTicker(): void {
		const intervalMs = this.#effectiveIntervalMs();
		if (this.#ticker !== undefined && this.#tickerIntervalMs === intervalMs) {
			return;
		}

		this.#stopTicker();
		this.#tickerIntervalMs = intervalMs;
		this.#ticker = setInterval(() => {
			this.refreshAll().catch((err) => streamDeck.logger.error("system monitor tick failed", err));
		}, intervalMs);
	}

	#stopTicker(): void {
		if (this.#ticker !== undefined) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
		this.#tickerIntervalMs = undefined;
	}

	async #refresh(
		target: SystemMonitorAction,
		settings: SystemMonitorSettings,
		revision: number
	): Promise<void> {
		let metrics: SystemMetrics | undefined;
		let diagnostic: "missing" | "unsupported" = "missing";
		try {
			metrics = await this.#sampler.read(false, this.#effectiveIntervalMs());
		} catch (err) {
			diagnostic = err instanceof UnsupportedSystemMetricsError ? "unsupported" : "missing";
			if (!(err instanceof UnsupportedSystemMetricsError)) {
				streamDeck.logger.error("failed to read Windows system metrics", err);
			}
		}

		await this.#render(target, settings, metrics, diagnostic, revision);
	}

	async #render(
		target: SystemMonitorAction,
		settings: SystemMonitorSettings,
		metrics: SystemMetrics | undefined,
		diagnostic: "missing" | "unsupported",
		revision: number
	): Promise<void> {
		if (!isCurrentSystemMetricRevision(this.#settingsRevision.get(target.id), revision)) {
			return;
		}

		const metric = isSystemMetricKind(settings.metric) ? settings.metric : DEFAULT_METRIC;
		const gpuIndex = normalizeGpuIndex(settings.gpuIndex);
		const diskDrive = normalizeDiskDriveSetting(settings.diskDrive);
		const reading = metrics === undefined ? { unit: metric === "network" ? "mbps" as const : metric === "gpu-power" ? "watts" as const : "percent" as const } : selectSystemMetric(metrics, metric, gpuIndex, diskDrive);
		const stale = metrics?.sampledAt !== undefined && Date.now() - metrics.sampledAt.getTime() > this.#effectiveIntervalMs() * 3;
		const status = metrics === undefined ? diagnostic : reading.value === undefined ? "missing" : stale ? "stale" : "ready";
		const face: SystemMonitorFace = {
			metric,
			value: reading.value,
			unit: reading.unit,
			temperatureC: reading.temperatureC,
			status,
			gpuIndex,
			diskDrive
		};

		try {
			if (target.isKey()) {
				await target.setTitle("");
				await target.setImage(renderSystemMonitor(face));
				return;
			}

			await target.setFeedbackLayout(DIAL_LAYOUT);
			const progress = systemMetricProgress(metric, reading.value);
			await target.setFeedback({
				title: systemHeaderLabel(metric, gpuIndex, diskDrive),
				temperature: formatSystemTemperature(face),
				value: formatSystemMetric(metric, reading.value, reading.unit),
				status: systemStatusLabel(status),
				// A missing reading leaves the bar empty rather than colouring a zero-length fill as a
				// real low value.
				indicator: { value: progress ?? 0, bar_fill_c: systemMonitorAccent(face) }
			});
		} catch (err) {
			streamDeck.logger.error("failed to render system monitor", err);
		}
	}

	#setSettings(actionId: string, settings: SystemMonitorSettings): number {
		const revision = (this.#settingsRevision.get(actionId) ?? 0) + 1;
		this.#settings.set(actionId, settings);
		this.#settingsRevision.set(actionId, revision);
		return revision;
	}
}

/**
 * Converts raw rotation ticks into whole metric steps, carrying the remainder to the next event.
 *
 * A reversal starts a fresh count, so turning back never has to first undo ticks carried over from
 * the opposite direction.
 */
export function accumulateRotationSteps(carried: number, ticks: number): { steps: number; remainder: number } {
	if (!Number.isFinite(ticks) || ticks === 0) {
		return { steps: 0, remainder: carried };
	}

	const total = Math.sign(carried) === -Math.sign(ticks) ? ticks : carried + ticks;
	// `|| 0` normalizes the -0 that Math.trunc yields for a partial backward turn.
	const steps = Math.trunc(total / TICKS_PER_METRIC_STEP) || 0;
	return { steps, remainder: total - steps * TICKS_PER_METRIC_STEP };
}

/** Prevents an older asynchronous refresh from overwriting a newer setting selection. */
export function isCurrentSystemMetricRevision(currentRevision: number | undefined, renderRevision: number): boolean {
	return currentRevision === renderRevision;
}

function normalizeGpuIndex(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 64 ? value : DEFAULT_GPU_INDEX;
}

/** A Property Inspector select stores its value as a string, so a number and a numeric string both count. */
export function normalizeRefreshSeconds(value: unknown): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : Number.NaN;
	if (!Number.isFinite(parsed)) {
		return DEFAULT_REFRESH_SECONDS;
	}

	return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(parsed)));
}

/**
 * The cadence of the shared ticker: the fastest interval any visible key asks for.
 *
 * The default is the answer for an empty set only. Folding it in as the seed instead would cap every
 * result at 15s and make the slower Property Inspector options inert.
 */
export function effectiveRefreshSeconds(settings: Iterable<SystemMonitorSettings>): number {
	let fastest: number | undefined;
	for (const entry of settings) {
		const seconds = normalizeRefreshSeconds(entry.refreshSeconds);
		fastest = fastest === undefined ? seconds : Math.min(fastest, seconds);
	}

	return fastest ?? DEFAULT_REFRESH_SECONDS;
}

function normalizeDiskDriveSetting(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function isDataSourceRequest(value: JsonValue): value is DataSourceRequest {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "event" in value;
}

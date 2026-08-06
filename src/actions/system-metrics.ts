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
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";

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

const REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_METRIC: SystemMetricKind = "cpu";
const DEFAULT_GPU_INDEX = 0;
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
};

type SystemMonitorAction = KeyAction<SystemMonitorSettings> | DialAction<SystemMonitorSettings>;

/** Displays local Windows CPU, memory, storage, network, and NVIDIA readings on one key. */
@action({ UUID: "com.kadragon.aiusage.system-monitor" })
export class SystemMonitor extends SingletonAction<SystemMonitorSettings> {
	#ticker?: NodeJS.Timeout;
	readonly #settings = new Map<string, SystemMonitorSettings>();
	readonly #settingsRevision = new Map<string, number>();
	readonly #rotation = new Map<string, number>();
	readonly #sampler = createWindowsMetricsSampler();

	override async onWillAppear(ev: WillAppearEvent<SystemMonitorSettings>): Promise<void> {
		this.#startTicker();
		const revision = this.#setSettings(ev.action.id, ev.payload.settings);
		await this.#refresh(ev.action, ev.payload.settings, revision);
	}

	override onWillDisappear(ev: WillDisappearEvent<SystemMonitorSettings>): void {
		this.#settings.delete(ev.action.id);
		this.#rotation.delete(ev.action.id);
		// The revision counter is deliberately kept: a context that reappears must not restart at a
		// value an in-flight render from the previous appearance could still match.
		if ([...this.actions].length === 0) {
			this.#stopTicker();
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SystemMonitorSettings>): Promise<void> {
		const revision = this.#setSettings(ev.action.id, ev.payload.settings);
		await this.#refresh(ev.action, ev.payload.settings, revision);
	}

	override async onKeyDown(_ev: KeyDownEvent<SystemMonitorSettings>): Promise<void> {
		// System Monitor is display-only; its ticker owns refreshes rather than key presses.
	}

	override onDialRotate(ev: DialRotateEvent<SystemMonitorSettings>): void {
		const steps = this.#accumulateRotation(ev.action.id, ev.payload.ticks);
		if (steps === 0) {
			return;
		}

		// Each handler terminates its own promise chain: a rejected refresh must never surface as an
		// unhandled rejection in the SDK callback.
		this.#cycleMetric(ev.action, ev.payload.settings, steps).catch((err) =>
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
			metrics = await this.#sampler.read(options.force === true);
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

	#startTicker(): void {
		this.#ticker ??= setInterval(() => {
			this.refreshAll().catch((err) => streamDeck.logger.error("system monitor tick failed", err));
		}, REFRESH_INTERVAL_MS);
	}

	#stopTicker(): void {
		if (this.#ticker !== undefined) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
	}

	async #refresh(
		target: SystemMonitorAction,
		settings: SystemMonitorSettings,
		revision: number
	): Promise<void> {
		let metrics: SystemMetrics | undefined;
		let diagnostic: "missing" | "unsupported" = "missing";
		try {
			metrics = await this.#sampler.read();
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
		const reading = metrics === undefined ? { unit: metric === "network" ? "mbps" as const : metric === "gpu-power" ? "watts" as const : "percent" as const } : selectSystemMetric(metrics, metric, gpuIndex);
		const stale = metrics?.sampledAt !== undefined && Date.now() - metrics.sampledAt.getTime() > REFRESH_INTERVAL_MS * 3;
		const status = metrics === undefined ? diagnostic : reading.value === undefined ? "missing" : stale ? "stale" : "ready";
		const face: SystemMonitorFace = {
			metric,
			value: reading.value,
			unit: reading.unit,
			temperatureC: reading.temperatureC,
			status,
			gpuIndex
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
				title: systemHeaderLabel(metric, gpuIndex),
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

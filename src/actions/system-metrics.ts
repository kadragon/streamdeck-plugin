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
import { isSystemMetricKind, type SystemMetricKind } from "../metrics/types";
import { formatSystemMetric, renderSystemMonitor, systemMetricProgress } from "../render";

const REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_METRIC: SystemMetricKind = "cpu";
const DEFAULT_GPU_INDEX = 0;

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
	readonly #sampler = createWindowsMetricsSampler();

	override async onWillAppear(ev: WillAppearEvent<SystemMonitorSettings>): Promise<void> {
		this.#startTicker();
		const revision = this.#setSettings(ev.action.id, ev.payload.settings);
		await this.#refresh(ev.action, ev.payload.settings, revision);
	}

	override onWillDisappear(ev: WillDisappearEvent<SystemMonitorSettings>): void {
		this.#settings.delete(ev.action.id);
		this.#settingsRevision.delete(ev.action.id);
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

	// Encoder events are intentionally no-ops: read-only feedback must not reject in the background.
	override onDialDown(_ev: DialDownEvent<SystemMonitorSettings>): void {}
	override onDialRotate(_ev: DialRotateEvent<SystemMonitorSettings>): void {}
	override onDialUp(_ev: DialUpEvent<SystemMonitorSettings>): void {}
	override onTouchTap(_ev: TouchTapEvent<SystemMonitorSettings>): void {}

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
		const image = renderSystemMonitor({
			metric,
			value: reading.value,
			unit: reading.unit,
			temperatureC: reading.temperatureC,
			status
		});

		try {
			if (target.isKey()) {
				await target.setTitle("");
				await target.setImage(image);
				return;
			}

			await target.setFeedbackLayout("$B1");
			await target.setFeedback({
				title: metric.toUpperCase(),
				value: formatSystemMetric(metric, reading.value, reading.unit),
				indicator: { value: systemMetricProgress(metric, reading.value) ?? 0 }
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

/** Prevents an older asynchronous refresh from overwriting a newer setting selection. */
export function isCurrentSystemMetricRevision(currentRevision: number | undefined, renderRevision: number): boolean {
	return currentRevision === renderRevision;
}

function normalizeGpuIndex(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 64 ? value : DEFAULT_GPU_INDEX;
}

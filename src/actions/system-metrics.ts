import {
	action,
	KeyAction,
	SingletonAction,
	streamDeck,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";

import { readWindowsMetrics, type SystemMetrics } from "../metrics/windows";
import { renderSystemMonitor, type SystemMetricKind } from "../render";

const REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_METRIC: SystemMetricKind = "cpu";

export type SystemMonitorSettings = {
	metric?: SystemMetricKind;
};

/** Displays local CPU and NVIDIA GPU utilization and temperature readings on one key. */
@action({ UUID: "com.kadragon.aiusage.system-monitor" })
export class SystemMonitor extends SingletonAction {
	#ticker?: NodeJS.Timeout;
	readonly #settings = new Map<string, SystemMonitorSettings>();

	override async onWillAppear(ev: WillAppearEvent<SystemMonitorSettings>): Promise<void> {
		this.#startTicker();
		this.#settings.set(ev.action.id, ev.payload.settings);
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override onWillDisappear(ev: WillDisappearEvent<SystemMonitorSettings>): void {
		this.#settings.delete(ev.action.id);
		// The SDK removes the action from `actions` before this handler runs, so an empty collection means
		// that no System Monitor key remains visible.
		if ([...this.actions].length === 0) {
			this.#stopTicker();
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SystemMonitorSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override async onKeyDown(_ev: KeyDownEvent<SystemMonitorSettings>): Promise<void> {
		// System Monitor is display-only; its five-second ticker owns refreshes rather than key presses.
	}

	/** Refreshes every visible key, for example after the machine wakes from sleep. */
	async refreshAll(): Promise<void> {
		await Promise.all(
			[...this.actions]
				.filter((visible) => visible.isKey())
				.map(async (visible) => {
					try {
						await this.#refresh(visible, this.#settings.get(visible.id) ?? {});
					} catch (err) {
						streamDeck.logger.error("system monitor refresh failed", err);
					}
				})
		);
	}

	#startTicker(): void {
		// A rejected promise escaping a timer callback can terminate the plugin process.
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

	async #refresh(target: KeyAction<SystemMonitorSettings>, settings: SystemMonitorSettings): Promise<void> {
		let metrics: SystemMetrics = {};
		try {
			metrics = await readWindowsMetrics();
		} catch (err) {
			streamDeck.logger.error("failed to read Windows system metrics", err);
		}

		try {
			const metric = settings.metric === "gpu" ? "gpu" : DEFAULT_METRIC;
			await target.setTitle("");
			await target.setImage(
				renderSystemMonitor({
					metric,
					usagePercent: metric === "gpu" ? metrics.gpuUsagePercent : metrics.cpuUsagePercent,
					temperatureC: metric === "gpu" ? metrics.gpuTemperatureC : metrics.cpuTemperatureC
				})
			);
		} catch (err) {
			streamDeck.logger.error("failed to render system monitor", err);
		}
	}
}

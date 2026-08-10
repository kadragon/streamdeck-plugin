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

import { formatCountdown, renderKey } from "../render";
import { projectExhaustion } from "../usage/burn-rate";
import { readClaudeUsage } from "../usage/claude";
import { readCodexUsage } from "../usage/codex";
import type { CodexApiFailure } from "../usage/codex-api";
import { NoUsageDataError, type UsageReading, type UsageSource } from "../usage/types";

/**
 * Settings for {@link WeeklyLimit}.
 */
type WeeklyLimitSettings = {
	source?: UsageSource;
	refreshSeconds?: number;
	/** Usage page opened on press; blank falls back to {@link DEFAULT_DASHBOARDS}. */
	dashboardUrl?: string;
	/** Percentage at which the number turns red. */
	alertPercent?: number;
};

/** How often the plugin re-reads the local files, when the user has not chosen otherwise. */
const DEFAULT_REFRESH_SECONDS = 60;

/** A reading older than this is marked stale, because the source tool has not run in a while. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Percentage at which the number turns red, when the user has not chosen otherwise. */
const DEFAULT_ALERT_PERCENT = 90;

/**
 * Usage page opened on press, per source.
 */
const DEFAULT_DASHBOARDS: Record<UsageSource, string> = {
	claude: "https://claude.ai/settings/usage",
	codex: "https://chatgpt.com/?openaicom_referred=true#settings/Usage"
};

/**
 * Readers take the caller's clock, because the Codex source dates an endpoint answer that carries no
 * observation time of its own; the Claude source reads only files and ignores it.
 */
const READERS: Record<UsageSource, (now: Date) => Promise<UsageReading>> = {
	claude: () => readClaudeUsage(),
	codex: (now) => readCodexUsage(undefined, { now, onFailure: (failure) => streamDeck.logger.warn(usageEndpointMessage(failure)) })
};

/**
 * Wording for a usage-endpoint failure.
 *
 * The endpoint falling back to the rollouts is not an error — the key still shows a reading — but it
 * is silent, so a payload change or a revoked token would otherwise look like a healthy plugin
 * forever. The reason is spelled out because each one has a different fix: re-run `codex` to renew
 * credentials, wait out a 5xx, or update the reader for a changed payload.
 */
function usageEndpointMessage(failure: CodexApiFailure): string {
	switch (failure.kind) {
		case "no-credentials":
			return "codex usage endpoint skipped: no usable credentials in auth.json; falling back to rollout files";
		case "http-error":
			return `codex usage endpoint returned HTTP ${failure.status}; falling back to rollout files`;
		case "network-error":
			return `codex usage endpoint unreachable: ${failure.message}; falling back to rollout files`;
		case "invalid-body":
			return "codex usage endpoint returned no usable weekly percentage; falling back to rollout files";
	}
}

/**
 * Displays the share of the weekly rate-limit allowance a tool has already consumed.
 *
 * Readings come from the files the tools write themselves, plus — for Codex — the usage-only endpoint
 * its CLI polls, so an idle Codex no longer freezes the key. Pressing the key opens the usage page.
 */
@action({ UUID: "com.kadragon.aiusage.limit" })
export class WeeklyLimit extends SingletonAction<WeeklyLimitSettings> {
	/** Wall-clock of the last refresh per action, so each key honours its own refresh interval. */
	readonly #lastRefresh = new Map<string, number>();

	/**
	 * Latest settings per action.
	 *
	 * `action.getSettings()` is an IPC round-trip to the Stream Deck app, not a local read, so calling it
	 * on every tick would put a request per key per second on the wire. Every settings change arrives as
	 * an event anyway, so the events are the source of truth.
	 */
	readonly #settings = new Map<string, WeeklyLimitSettings>();

	/** The shared ticker; it exists only while at least one key is visible. */
	#ticker?: NodeJS.Timeout;

	override async onWillAppear(ev: WillAppearEvent<WeeklyLimitSettings>): Promise<void> {
		this.#startTicker();
		this.#settings.set(ev.action.id, ev.payload.settings);
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override onWillDisappear(ev: WillDisappearEvent<WeeklyLimitSettings>): void {
		this.#lastRefresh.delete(ev.action.id);
		this.#settings.delete(ev.action.id);

		// The SDK removes the action from `actions` before this handler runs, so what is left here is
		// exactly the keys that stay visible.
		if ([...this.actions].length === 0) {
			this.#stopTicker();
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<WeeklyLimitSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	/**
	 * Opens the source's usage page. The key refreshes on its own interval, so a press does not re-read.
	 */
	override async onKeyDown(ev: KeyDownEvent<WeeklyLimitSettings>): Promise<void> {
		const { settings } = ev.payload;
		const url = settings.dashboardUrl?.trim() || DEFAULT_DASHBOARDS[settings.source ?? "claude"];

		if (url === "") {
			await ev.action.showAlert();
			return;
		}

		await streamDeck.system.openUrl(url);
	}

	/**
	 * Refreshes every visible key, e.g. after the machine wakes and the readings are certainly stale.
	 */
	async refreshAll(): Promise<void> {
		for (const visible of this.actions) {
			if (visible.isKey()) {
				await this.#refresh(visible, this.#settings.get(visible.id) ?? {});
			}
		}
	}

	/**
	 * Ticks every second so each key can refresh as soon as its own interval elapses.
	 */
	#startTicker(): void {
		// A rejection escaping the callback would be an unhandled rejection, which Node terminates the
		// plugin process over; the ticker has to swallow and log instead.
		this.#ticker ??= setInterval(() => {
			this.#tick().catch((err) => streamDeck.logger.error("usage tick failed", err));
		}, 1000);
	}

	#stopTicker(): void {
		if (this.#ticker !== undefined) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
	}

	async #tick(): Promise<void> {
		const now = Date.now();

		for (const visible of this.actions) {
			if (!visible.isKey()) {
				continue;
			}

			const settings = this.#settings.get(visible.id) ?? {};
			const intervalMs = Math.max(5, settings.refreshSeconds ?? DEFAULT_REFRESH_SECONDS) * 1000;
			if (now - (this.#lastRefresh.get(visible.id) ?? 0) < intervalMs) {
				continue;
			}

			await this.#refresh(visible, settings);
		}
	}

	/**
	 * Reads the configured source and redraws a single key.
	 *
	 * @returns `true` when a reading was obtained.
	 */
	async #refresh(target: KeyAction<WeeklyLimitSettings>, settings: WeeklyLimitSettings): Promise<boolean> {
		const source = settings.source ?? "claude";
		this.#lastRefresh.set(target.id, Date.now());

		// The title would overlap the rendered face, so the face carries all the text.
		await target.setTitle("");

		const now = new Date();

		let reading: UsageReading;
		try {
			reading = await READERS[source](now);
		} catch (err) {
			if (!(err instanceof NoUsageDataError)) {
				streamDeck.logger.error(`failed to read ${source} usage`, err);
			}

			await target.setImage(renderKey({ source, caption: "no data" }));
			return false;
		}

		const stale = now.getTime() - reading.observedAt.getTime() > STALE_AFTER_MS;
		const { caption, warn } = this.#caption(reading, now, stale);

		await target.setImage(
			renderKey({
				source,
				usedPercent: reading.usedPercent,
				caption,
				stale,
				warn,
				danger: reading.usedPercent >= (settings.alertPercent ?? DEFAULT_ALERT_PERCENT)
			})
		);
		return true;
	}

	/**
	 * Picks what the caption should say.
	 *
	 * The projection wins over the reset countdown only when the allowance would run out first — that is
	 * the case worth acting on, and showing it otherwise would just be noise.
	 *
	 * The three wordings are deliberately distinct, since all of them are durations: "in 3d 12h" counts
	 * down to the reset, "out in 4h 20m" to running dry, and "3d 12h ago" is the age of the reading.
	 */
	#caption(reading: UsageReading, now: Date, stale: boolean): { caption: string; warn: boolean } {
		if (stale) {
			return { caption: `${formatCountdown(now, reading.observedAt)} ago`, warn: false };
		}

		const projection = projectExhaustion(reading, now);
		if (projection !== undefined && (reading.resetsAt === undefined || projection.exhaustsAt < reading.resetsAt)) {
			return { caption: `out in ${formatCountdown(projection.exhaustsAt, now)}`, warn: true };
		}

		if (reading.resetsAt !== undefined) {
			return { caption: `in ${formatCountdown(reading.resetsAt, now)}`, warn: false };
		}

		return { caption: "", warn: false };
	}
}

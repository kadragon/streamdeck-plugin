import {
	action,
	SingletonAction,
	streamDeck,
	type DialAction,
	type DialDownEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";

import { projectExhaustion } from "../usage/burn-rate";
import { readClaudeUsage } from "../usage/claude";
import { readCodexUsage } from "../usage/codex";
import { getOverviewMetric, nextUsageOverviewMode, normalizeUsageOverviewMode, type OverviewProvider, type UsageOverviewMode } from "../usage/overview";
import { NoUsageDataError, type UsageReading, type UsageSource } from "../usage/types";
import { renderUsageOverview, type UsageOverviewFace, type UsageOverviewProviderFace } from "../render";

const DEFAULT_REFRESH_SECONDS = 60;
const DEFAULT_ALERT_PERCENT = 90;
const PROVIDER_CACHE_TTL_MS = 5_000;

export type UsageOverviewSettings = {
	mode?: UsageOverviewMode;
	refreshSeconds?: number;
	alertPercent?: number;
};

type OverviewAction = KeyAction<UsageOverviewSettings> | DialAction<UsageOverviewSettings>;
type Reader = () => Promise<UsageReading>;

const READERS: Record<UsageSource, Reader> = {
	claude: readClaudeUsage,
	codex: readCodexUsage
};

/** Shows combined Claude/Codex usage and cycles the displayed view on press. */
@action({ UUID: "com.kadragon.aiusage.overview" })
export class UsageOverview extends SingletonAction<UsageOverviewSettings> {
	#ticker?: NodeJS.Timeout;
	#providerSample?: { startedAt: number; promise: Promise<[OverviewProvider, OverviewProvider]> };
	readonly #settings = new Map<string, UsageOverviewSettings>();
	readonly #lastRefresh = new Map<string, number>();
	readonly #settingsRevision = new Map<string, number>();

	override async onWillAppear(ev: WillAppearEvent<UsageOverviewSettings>): Promise<void> {
		const revision = this.#setSettings(ev.action.id, ev.payload.settings);
		this.#startTicker();
		await this.#refresh(ev.action, ev.payload.settings, revision);
	}

	override onWillDisappear(ev: WillDisappearEvent<UsageOverviewSettings>): void {
		this.#settings.delete(ev.action.id);
		this.#lastRefresh.delete(ev.action.id);
		// The revision counter is deliberately kept so a reappearing context cannot reuse a value an
		// in-flight render from the previous appearance still matches.
		if ([...this.actions].length === 0) {
			this.#stopTicker();
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UsageOverviewSettings>): Promise<void> {
		const revision = this.#setSettings(ev.action.id, ev.payload.settings);
		await this.#refresh(ev.action, ev.payload.settings, revision);
	}

	override async onKeyDown(ev: KeyDownEvent<UsageOverviewSettings>): Promise<void> {
		await this.#cycle(ev.action, ev.payload.settings);
	}

	override async onDialDown(ev: DialDownEvent<UsageOverviewSettings>): Promise<void> {
		await this.#cycle(ev.action, ev.payload.settings);
	}

	override onDialUp(_ev: DialUpEvent<UsageOverviewSettings>): void {}
	override onTouchTap(_ev: TouchTapEvent<UsageOverviewSettings>): void {}

	async refreshAll(): Promise<void> {
		await Promise.all([...this.actions].map(async (target) => {
			try {
				await this.#refresh(target, this.#settings.get(target.id) ?? {}, this.#settingsRevision.get(target.id) ?? 0);
			} catch (err) {
				streamDeck.logger.error("usage overview refresh failed", err);
			}
		}));
	}

	#startTicker(): void {
		this.#ticker ??= setInterval(() => {
			this.#tick().catch((err) => streamDeck.logger.error("usage overview tick failed", err));
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
		for (const target of this.actions) {
			const settings = this.#settings.get(target.id) ?? {};
			const intervalMs = Math.max(5, settings.refreshSeconds ?? DEFAULT_REFRESH_SECONDS) * 1000;
			if (now - (this.#lastRefresh.get(target.id) ?? 0) >= intervalMs) {
				await this.#refresh(target, settings, this.#settingsRevision.get(target.id) ?? 0);
			}
		}
	}

	async #cycle(target: OverviewAction, settings: UsageOverviewSettings): Promise<void> {
		try {
			const nextSettings = { ...settings, mode: nextUsageOverviewMode(settings.mode) };
			const revision = this.#setSettings(target.id, nextSettings);
			await target.setSettings(nextSettings);
			await this.#refresh(target, nextSettings, revision);
		} catch (err) {
			streamDeck.logger.error("failed to cycle usage overview mode", err);
		}
	}

	async #refresh(target: OverviewAction, settings: UsageOverviewSettings, revision: number): Promise<void> {
		this.#lastRefresh.set(target.id, Date.now());
		const now = new Date();
		const [claude, codex] = await this.#readProviders(now);
		if (!isCurrentUsageOverviewRevision(this.#settingsRevision.get(target.id), revision)) {
			return;
		}

		const mode = normalizeUsageOverviewMode(settings.mode);
		const alertPercent = normalizeAlertPercent(settings.alertPercent);
		const face: UsageOverviewFace = {
			mode,
			claude: toFace(claude, mode, now, alertPercent),
			codex: toFace(codex, mode, now, alertPercent)
		};

		try {
			if (target.isKey()) {
				await target.setTitle("");
				await target.setImage(renderUsageOverview(face));
				return;
			}

			// $C1 carries no value slot, so the figures ride in the title; burn/reset have no progress.
			await target.setFeedbackLayout("$C1");
			await target.setFeedback({
				title: `${mode.toUpperCase()} C ${face.claude.text} | X ${face.codex.text}`,
				indicator1: { value: face.claude.progress ?? 0 },
				indicator2: { value: face.codex.progress ?? 0 }
			});
		} catch (err) {
			streamDeck.logger.error("failed to render usage overview", err);
		}
	}

	/** Shares one provider read across every visible instance instead of re-reading per key. */
	async #readProviders(now: Date): Promise<[OverviewProvider, OverviewProvider]> {
		const current = this.#providerSample;
		if (current !== undefined && Date.now() - current.startedAt < PROVIDER_CACHE_TTL_MS) {
			return current.promise;
		}

		const promise = Promise.all([this.#readProvider("claude", now), this.#readProvider("codex", now)]) as Promise<[OverviewProvider, OverviewProvider]>;
		this.#providerSample = { startedAt: Date.now(), promise };
		return promise;
	}

	#setSettings(actionId: string, settings: UsageOverviewSettings): number {
		const revision = (this.#settingsRevision.get(actionId) ?? 0) + 1;
		this.#settings.set(actionId, settings);
		this.#settingsRevision.set(actionId, revision);
		return revision;
	}

	async #readProvider(source: UsageSource, now: Date): Promise<OverviewProvider> {
		try {
			const reading = await READERS[source]();
			return { source, reading, burn: projectExhaustion(reading, now) };
		} catch (err) {
			if (!(err instanceof NoUsageDataError)) {
				streamDeck.logger.error(`failed to read ${source} usage for overview`, err);
			}
			return { source };
		}
	}
}

/** Prevents an older asynchronous refresh from overwriting a newer mode selection. */
export function isCurrentUsageOverviewRevision(currentRevision: number | undefined, renderRevision: number): boolean {
	return currentRevision === renderRevision;
}

function toFace(provider: OverviewProvider, mode: UsageOverviewMode, now: Date, alertPercent: number): UsageOverviewProviderFace {
	return {
		source: provider.source,
		...getOverviewMetric(provider, mode, now, alertPercent)
	};
}

function normalizeAlertPercent(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 50 && value <= 100 ? value : DEFAULT_ALERT_PERCENT;
}

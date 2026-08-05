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

import { focusWarpTab } from "../agent-attention/focus";
import { AgentAttentionMonitor } from "../agent-attention/monitor";
import { AgentAttentionStore } from "../agent-attention/store";
import { normalizeUsageSource, normalizeWarpTab } from "../agent-attention/types";
import { renderAgentKey } from "../render";
import type { UsageSource } from "../usage/types";

export type AgentAttentionSettings = {
	source?: UsageSource;
	tabNumber?: number;
};

const DEFAULT_SOURCE: UsageSource = "claude";
const DEFAULT_TAB = 1;
const BLINK_INTERVAL_MS = 500;
const POLL_INTERVAL_MS = 250;

/** Displays attention from a wrapped Claude Code or Codex CLI process in a fixed Warp tab slot. */
@action({ UUID: "com.kadragon.aiusage.agent-attention" })
export class AgentAttention extends SingletonAction<AgentAttentionSettings> {
	readonly #store = new AgentAttentionStore();
	readonly #monitor = new AgentAttentionMonitor({
		intervalMs: POLL_INTERVAL_MS,
		onError: (error) => streamDeck.logger.error("agent attention monitor failed", error)
	});
	readonly #settings = new Map<string, AgentAttentionSettings>();
	#ticker?: NodeJS.Timeout;
	#renderInFlight = false;

	constructor() {
		super();
		this.#monitor.subscribe((event) => this.#store.apply(event));
	}

	override async onWillAppear(ev: WillAppearEvent<AgentAttentionSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#startService();
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override onWillDisappear(ev: WillDisappearEvent<AgentAttentionSettings>): void {
		this.#settings.delete(ev.action.id);

		if ([...this.actions].length === 0) {
			this.#stopService();
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AgentAttentionSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<AgentAttentionSettings>): Promise<void> {
		const source = normalizeUsageSource(ev.payload.settings.source) ?? DEFAULT_SOURCE;
		const tabNumber = normalizeWarpTab(ev.payload.settings.tabNumber) ?? DEFAULT_TAB;

		const result = await focusWarpTab(tabNumber);
		if (!result.ok) {
			streamDeck.logger.error(`failed to focus Warp tab ${tabNumber}`, result.reason);
			await ev.action.showAlert();
		} else {
			this.#store.dismiss(source, tabNumber);
		}

		await this.#refresh(ev.action, ev.payload.settings);
	}

	#startService(): void {
		this.#ticker ??= setInterval(() => {
			this.#renderVisible().catch((error) => streamDeck.logger.error("agent attention render failed", error));
		}, BLINK_INTERVAL_MS);

		if (!this.#monitorRunning) {
			this.#monitorRunning = true;
			this.#monitor
				.start()
				.then((started) => {
					if (!started) {
						this.#monitorRunning = false;
					}
				})
				.catch((error) => {
					this.#monitorRunning = false;
					streamDeck.logger.error("agent attention monitor start failed", error);
				});
		}
	}

	#monitorRunning = false;

	#stopService(): void {
		if (this.#ticker !== undefined) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}

		this.#monitor.stop();
		this.#monitorRunning = false;
	}

	async #renderVisible(): Promise<void> {
		if (this.#renderInFlight) {
			return;
		}

		this.#renderInFlight = true;
		try {
			for (const visible of this.actions) {
				if (visible.isKey()) {
					await this.#refresh(visible, this.#settings.get(visible.id) ?? {});
				}
			}
		} finally {
			this.#renderInFlight = false;
		}
	}

	async #refresh(target: KeyAction<AgentAttentionSettings>, settings: AgentAttentionSettings): Promise<void> {
		const source = normalizeUsageSource(settings.source) ?? DEFAULT_SOURCE;
		const tabNumber = normalizeWarpTab(settings.tabNumber) ?? DEFAULT_TAB;
		const snapshot = this.#store.snapshot(source, tabNumber);
		const attention = this.#store.isAttentionVisible(source, tabNumber);
		const blinkOn = attention && Math.floor(Date.now() / BLINK_INTERVAL_MS) % 2 === 0;

		await target.setTitle("");
		await target.setImage(
			renderAgentKey({
				source,
				tabNumber,
				status: snapshot?.status === "exited" ? undefined : snapshot?.status,
				reason: snapshot?.reason,
				blinkOn
			})
		);
	}
}

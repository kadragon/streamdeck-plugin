import {
	action,
	SingletonAction,
	streamDeck,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";

import { focusHcAgent, readHcAgentStatus, type HcAgentStatusReading, type HcDisplayMode } from "../hc/status";
import { renderHcAgentKey } from "../render";

const REFRESH_INTERVAL_MS = 5000;

type HcSettings = { mode?: HcDisplayMode };

@action({ UUID: "com.kadragon.aiusage.hc-agent-status" })
export class HcAgentStatus extends SingletonAction<HcSettings> {
	readonly #modes = new Map<string, HcDisplayMode>();
	#ticker?: NodeJS.Timeout;
	#refreshing?: Promise<void>;
	/** Tail of the press queue: every press focuses one session, in press order. */
	#focusing: Promise<void> = Promise.resolve();
	readonly #lastFocused: Partial<Record<HcDisplayMode, string>> = {};
	#reading?: HcAgentStatusReading;

	constructor(
		private readonly readStatus = readHcAgentStatus,
		private readonly focusAgent = focusHcAgent
	) {
		super();
	}

	override async onWillAppear(event: WillAppearEvent<HcSettings>): Promise<void> {
		this.#setMode(event.action.id, event.payload.settings);
		if (event.action.isKey()) {
			await event.action.setTitle("").catch((error) => streamDeck.logger.error("HC key title update failed", error));
		}
		if ([...this.actions].length > 0) {
			this.#ticker ??= setInterval(() => {
				this.refreshAll().catch((error) => streamDeck.logger.error("HC status tick failed", error));
			}, REFRESH_INTERVAL_MS);
		}
		await this.refreshAll();
	}

	override onWillDisappear(event: WillDisappearEvent<HcSettings>): void {
		this.#modes.delete(event.action.id);
		if ([...this.actions].length === 0) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
	}

	override async onDidReceiveSettings(event: DidReceiveSettingsEvent<HcSettings>): Promise<void> {
		this.#setMode(event.action.id, event.payload.settings);
		if (event.action.isKey()) {
			await event.action.setImage(this.#image(event.action.id))
				.catch((error) => streamDeck.logger.error("HC key mode render failed", error));
		}
	}

	override async onKeyDown(event: KeyDownEvent<HcSettings>): Promise<void> {
		const mode = this.#modes.get(event.action.id) ?? "running";
		const task = this.#focusing
			.then(() => this.#focusNextAgent(mode))
			.catch((error: NodeJS.ErrnoException) => {
				streamDeck.logger.error("HC agent focus failed", error.code ?? error.name);
			});
		this.#focusing = task;
		await task;
	}

	async refreshAll(): Promise<void> {
		if ([...this.actions].length === 0) {
			return;
		}
		this.#refreshing ??= this.#refresh().finally(() => {
			this.#refreshing = undefined;
		});
		await this.#refreshing;
	}

	async #refresh(): Promise<void> {
		this.#reading = await this.readStatus().catch((error: NodeJS.ErrnoException) => {
			// Do not log subprocess output, which can include terminal metadata.
			streamDeck.logger.debug("HC terminal list unavailable", error.code ?? error.name);
			return undefined;
		});
		const results = await Promise.allSettled([...this.actions].map((visible) => (
			visible.isKey() ? visible.setImage(this.#image(visible.id)) : undefined
		)));
		for (const result of results) {
			if (result.status === "rejected") {
				streamDeck.logger.error("HC status render failed", result.reason);
			}
		}
	}

	async #focusNextAgent(mode: HcDisplayMode): Promise<void> {
		// A tick already in flight read `hc ls` before this press; wait for it, then read again.
		await this.#refreshing?.catch(() => undefined);
		await this.refreshAll();
		// With no key left, refreshAll() skipped the read and the cached list may be stale.
		if ([...this.actions].length === 0) {
			return;
		}
		const addresses = this.#reading?.[mode].filter((address) => address !== undefined) ?? [];
		const previous = addresses.findIndex((address) => address === this.#lastFocused[mode]);
		const next = addresses[previous + 1] ?? addresses[0];
		if (next === undefined) {
			delete this.#lastFocused[mode];
			return;
		}
		await this.focusAgent(next);
		this.#lastFocused[mode] = next;
	}

	#setMode(id: string, settings: HcSettings): void {
		this.#modes.set(id, settings.mode === "waiting" ? "waiting" : "running");
	}

	#image(id: string): string {
		return renderHcAgentKey(this.#modes.get(id) ?? "running", this.#reading);
	}
}

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

import { IDLE, normalizeIntervalMinutes, pressBreakTimer, resolveBreakTimer, type BreakTimerState } from "../break-timer/state";
import { renderBreakTimerKey } from "../render";

/**
 * Settings for {@link BreakTimer}. Only the interval is persisted; the timer itself is not.
 */
type BreakTimerSettings = {
	intervalMinutes?: number | string;
};

/**
 * A work-interval countdown that shows when to take a break without ever interrupting work.
 *
 * Press to start, pause, or resume; when the time is up the key changes to a steady break face and
 * waits for a press to start the next cycle. Timer state lives in memory only, so a plugin restart
 * returns every key to idle, while a sleep/wake keeps the absolute end time and resolves against it.
 */
@action({ UUID: "com.kadragon.aiusage.break-timer" })
export class BreakTimer extends SingletonAction<BreakTimerSettings> {
	/** Timer state per action, kept across page switches so hiding a key does not reset it. */
	readonly #states = new Map<string, BreakTimerState>();

	/** Latest interval per action, in minutes; settings events are the source of truth. */
	readonly #intervals = new Map<string, number>();

	/** Redraws running countdowns once a second; it exists only while at least one key is visible. */
	#ticker?: NodeJS.Timeout;

	override async onWillAppear(ev: WillAppearEvent<BreakTimerSettings>): Promise<void> {
		this.#intervals.set(ev.action.id, normalizeIntervalMinutes(ev.payload.settings.intervalMinutes));
		this.#startTicker();
		if (ev.action.isKey()) {
			await this.#render(ev.action);
		}
	}

	override onWillDisappear(): void {
		// The SDK removes the action from `actions` before this handler runs, so what is left here is
		// exactly the keys that stay visible. State is kept: the end time is absolute, so it needs no ticks.
		if ([...this.actions].length === 0) {
			this.#stopTicker();
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<BreakTimerSettings>): Promise<void> {
		const minutes = normalizeIntervalMinutes(ev.payload.settings.intervalMinutes);
		if (this.#intervals.get(ev.action.id) !== minutes) {
			// A new interval would make a countdown from the old one misleading, so start over.
			this.#intervals.set(ev.action.id, minutes);
			this.#states.set(ev.action.id, IDLE);
		}

		if (ev.action.isKey()) {
			await this.#render(ev.action);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<BreakTimerSettings>): Promise<void> {
		const state = this.#states.get(ev.action.id) ?? IDLE;
		this.#states.set(ev.action.id, pressBreakTimer(state, this.#intervalMs(ev.action.id), Date.now()));
		await this.#render(ev.action);
	}

	/**
	 * Redraws every visible key, e.g. after the machine wakes and a countdown may have run out.
	 */
	async refreshAll(): Promise<void> {
		for (const visible of this.actions) {
			if (visible.isKey()) {
				await this.#render(visible);
			}
		}
	}

	#startTicker(): void {
		// A rejection escaping the callback would be an unhandled rejection, which Node terminates the
		// plugin process over; the ticker has to swallow and log instead.
		this.#ticker ??= setInterval(() => {
			this.#tick().catch((err) => streamDeck.logger.error("break timer tick failed", err));
		}, 1000);
	}

	#stopTicker(): void {
		if (this.#ticker !== undefined) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
	}

	async #tick(): Promise<void> {
		for (const visible of this.actions) {
			if (visible.isKey() && this.#states.get(visible.id)?.phase === "running") {
				await this.#render(visible);
			}
		}
	}

	async #render(target: KeyAction<BreakTimerSettings>): Promise<void> {
		const view = resolveBreakTimer(this.#states.get(target.id) ?? IDLE, Date.now());
		if (view.phase === "break") {
			// Settle the expiry so the ticker stops redrawing this key; only a press leaves `break`.
			this.#states.set(target.id, view);
		}

		// The face carries all the text, so the native title would only overlap it.
		await target.setTitle("");
		await target.setImage(renderBreakTimerKey(view, this.#intervalMs(target.id)));
	}

	#intervalMs(actionId: string): number {
		return (this.#intervals.get(actionId) ?? normalizeIntervalMinutes(undefined)) * 60_000;
	}
}

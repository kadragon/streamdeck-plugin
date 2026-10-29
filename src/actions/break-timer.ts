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
 * How long the interval must stay unchanged before it resets the key.
 *
 * The inspector's text field saves on every keystroke, so retyping "25" passes through "2"; applying
 * each intermediate value would throw away a running countdown even when the final value is the same.
 */
const INTERVAL_SETTLE_MS = 1500;

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

	/** Applied interval per action, in minutes; settings events are the source of truth. */
	readonly #intervals = new Map<string, number>();

	/** Pending interval changes, applied once the inspector stops saving new values. */
	readonly #pendingIntervals = new Map<string, NodeJS.Timeout>();

	/** Redraws running countdowns once a second; it exists only while at least one key is visible. */
	#ticker?: NodeJS.Timeout;

	override async onWillAppear(ev: WillAppearEvent<BreakTimerSettings>): Promise<void> {
		// An interval changed while the key was hidden resets it, just as a change seen live does.
		this.#applyInterval(ev.action.id, normalizeIntervalMinutes(ev.payload.settings.intervalMinutes));
		this.#startTicker();
		if (ev.action.isKey()) {
			// The face carries all the text, so the native title would only overlap it.
			await ev.action.setTitle("");
			await this.#render(ev.action);
		}
	}

	override onWillDisappear(ev: WillDisappearEvent<BreakTimerSettings>): void {
		this.#cancelPendingInterval(ev.action.id);

		// The SDK removes the action from `actions` before this handler runs, so what is left here is
		// exactly the keys that stay visible. State is kept: the end time is absolute, so it needs no ticks.
		if ([...this.actions].length === 0) {
			this.#stopTicker();
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<BreakTimerSettings>): void {
		const minutes = normalizeIntervalMinutes(ev.payload.settings.intervalMinutes);
		const target = ev.action;

		this.#cancelPendingInterval(target.id);
		this.#pendingIntervals.set(
			target.id,
			setTimeout(() => {
				this.#pendingIntervals.delete(target.id);
				if (this.#applyInterval(target.id, minutes) && target.isKey()) {
					this.#render(target).catch((err) => streamDeck.logger.error("break timer settings render failed", err));
				}
			}, INTERVAL_SETTLE_MS)
		);
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
		await this.#renderEach(() => true);
	}

	#startTicker(): void {
		// A rejection escaping the callback would be an unhandled rejection, which Node terminates the
		// plugin process over; the ticker has to swallow and log instead.
		this.#ticker ??= setInterval(() => {
			this.#renderEach((id) => this.#states.get(id)?.phase === "running").catch((err) => streamDeck.logger.error("break timer tick failed", err));
		}, 1000);
	}

	#stopTicker(): void {
		if (this.#ticker !== undefined) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
	}

	/** Renders the matching visible keys independently, so one failed key cannot stall the others. */
	async #renderEach(include: (actionId: string) => boolean): Promise<void> {
		const keys = [...this.actions].filter((visible): visible is KeyAction<BreakTimerSettings> => visible.isKey() && include(visible.id));
		const results = await Promise.allSettled(keys.map((key) => this.#render(key)));
		for (const result of results) {
			if (result.status === "rejected") {
				streamDeck.logger.error("break timer render failed", result.reason);
			}
		}
	}

	/**
	 * Draws the key from the state as it is right now.
	 *
	 * The view is resolved with no await before `setImage`, so a tick cannot paint a face computed
	 * before a key press over the face the press just drew.
	 */
	async #render(target: KeyAction<BreakTimerSettings>): Promise<void> {
		const view = resolveBreakTimer(this.#states.get(target.id) ?? IDLE, Date.now());
		if (view.phase === "break") {
			// Settle the expiry so the ticker stops redrawing this key; only a press leaves `break`.
			this.#states.set(target.id, view);
		}

		await target.setImage(renderBreakTimerKey(view, this.#intervalMs(target.id)));
	}

	/**
	 * Records the interval and resets the key when it differs from the one in use.
	 *
	 * @returns `true` when the interval changed.
	 */
	#applyInterval(actionId: string, minutes: number): boolean {
		const previous = this.#intervals.get(actionId);
		this.#intervals.set(actionId, minutes);
		if (previous === undefined || previous === minutes) {
			return false;
		}

		// A new interval would make a countdown from the old one misleading, so start over.
		this.#states.set(actionId, IDLE);
		return true;
	}

	#cancelPendingInterval(actionId: string): void {
		const pending = this.#pendingIntervals.get(actionId);
		if (pending !== undefined) {
			clearTimeout(pending);
			this.#pendingIntervals.delete(actionId);
		}
	}

	#intervalMs(actionId: string): number {
		return (this.#intervals.get(actionId) ?? normalizeIntervalMinutes(undefined)) * 60_000;
	}
}

/**
 * Break timer state, kept pure so every transition can be tested against a fake clock.
 *
 * A running timer stores an absolute end time rather than a remaining count, so a machine that slept
 * through the end resolves straight to `break` on wake instead of resuming where the ticks stopped.
 */
export type BreakTimerState =
	| { phase: "idle" }
	| { phase: "running"; endsAt: number }
	| { phase: "paused"; remainingMs: number }
	| { phase: "break" };

/** What the key face shows at a given moment; `break` is derived from the clock, never scheduled. */
export type BreakTimerView =
	| { phase: "idle" }
	| { phase: "running"; endsAt: number; remainingMs: number }
	| { phase: "paused"; remainingMs: number }
	| { phase: "break" };

export const IDLE: BreakTimerState = { phase: "idle" };

/** Work interval used when the user has not chosen one, or chose one outside the accepted range. */
export const DEFAULT_INTERVAL_MINUTES = 25;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 180;

/** Accepts an integer number of minutes from the Property Inspector, which may arrive as a string. */
export function normalizeIntervalMinutes(value: unknown): number {
	// Only plain decimal digits count: `Number()` would also accept "1e2", "0x1F", or "60.0".
	const minutes = typeof value === "string" ? (/^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : undefined) : value;
	if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
		return DEFAULT_INTERVAL_MINUTES;
	}

	return minutes;
}

/** Resolves the stored state against the clock. */
export function resolveBreakTimer(state: BreakTimerState, now: number): BreakTimerView {
	if (state.phase !== "running") {
		return state;
	}

	const remainingMs = state.endsAt - now;
	return remainingMs > 0 ? { phase: "running", endsAt: state.endsAt, remainingMs } : { phase: "break" };
}

/**
 * Applies a key press: start, pause, resume, or start the next cycle after a break.
 *
 * The press is judged against the resolved view, so pressing a key whose end time has already passed
 * starts a new cycle rather than pausing one that is over.
 */
export function pressBreakTimer(state: BreakTimerState, intervalMs: number, now: number): BreakTimerState {
	const view = resolveBreakTimer(state, now);
	switch (view.phase) {
		case "idle":
		case "break":
			return { phase: "running", endsAt: now + intervalMs };
		case "running":
			return { phase: "paused", remainingMs: view.remainingMs };
		case "paused":
			return { phase: "running", endsAt: now + view.remainingMs };
	}
}

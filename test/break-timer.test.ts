import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_INTERVAL_MINUTES, IDLE, normalizeIntervalMinutes, pressBreakTimer, resolveBreakTimer } from "../src/break-timer/state";

const MINUTE = 60_000;
const INTERVAL = 25 * MINUTE;

test("a press cycles idle -> running -> paused -> running and keeps the remaining time", () => {
	let now = 1_000_000;
	let state = pressBreakTimer(IDLE, INTERVAL, now);
	assert.deepEqual(resolveBreakTimer(state, now), { phase: "running", remainingMs: INTERVAL, endsAt: now + INTERVAL });

	now += 10 * MINUTE;
	state = pressBreakTimer(state, INTERVAL, now);
	assert.deepEqual(state, { phase: "paused", remainingMs: 15 * MINUTE });

	// Time spent paused does not count down.
	now += 60 * MINUTE;
	assert.deepEqual(resolveBreakTimer(state, now), { phase: "paused", remainingMs: 15 * MINUTE });

	state = pressBreakTimer(state, INTERVAL, now);
	assert.deepEqual(state, { phase: "running", endsAt: now + 15 * MINUTE });
});

test("reaching the end time shows a break and never restarts on its own", () => {
	const start = 0;
	const running = pressBreakTimer(IDLE, INTERVAL, start);

	assert.equal(resolveBreakTimer(running, INTERVAL - 1).phase, "running");
	assert.deepEqual(resolveBreakTimer(running, INTERVAL), { phase: "break" });
	assert.deepEqual(resolveBreakTimer(running, INTERVAL + 5 * 60 * MINUTE), { phase: "break" });

	// Only a press starts the next cycle, and it starts a full interval from the press.
	const next = pressBreakTimer(resolveBreakTimer(running, INTERVAL + 3 * MINUTE), INTERVAL, INTERVAL + 3 * MINUTE);
	assert.deepEqual(next, { phase: "running", endsAt: INTERVAL + 3 * MINUTE + INTERVAL });
});

test("a clock jump from sleep resolves against the absolute end time", () => {
	const running = pressBreakTimer(IDLE, INTERVAL, 0);

	assert.deepEqual(resolveBreakTimer(running, 20 * MINUTE), { phase: "running", remainingMs: 5 * MINUTE, endsAt: INTERVAL });
	assert.deepEqual(resolveBreakTimer(running, 8 * 60 * MINUTE), { phase: "break" });

	// A press that lands after the end time while the key still showed a countdown starts a new cycle
	// instead of pausing an expired one.
	assert.deepEqual(pressBreakTimer(running, INTERVAL, 8 * 60 * MINUTE), { phase: "running", endsAt: 8 * 60 * MINUTE + INTERVAL });
});

test("interval minutes accept integers 1-180 and fall back to the default otherwise", () => {
	assert.equal(DEFAULT_INTERVAL_MINUTES, 25);
	assert.equal(normalizeIntervalMinutes(undefined), 25);
	assert.equal(normalizeIntervalMinutes(1), 1);
	assert.equal(normalizeIntervalMinutes(180), 180);
	assert.equal(normalizeIntervalMinutes("50"), 50);
	assert.equal(normalizeIntervalMinutes(0), 25);
	assert.equal(normalizeIntervalMinutes(181), 25);
	assert.equal(normalizeIntervalMinutes(2.5), 25);
	assert.equal(normalizeIntervalMinutes(Number.NaN), 25);
	assert.equal(normalizeIntervalMinutes(""), 25);
	assert.equal(normalizeIntervalMinutes("abc"), 25);
	assert.equal(normalizeIntervalMinutes("1e2"), 25);
	assert.equal(normalizeIntervalMinutes("0x1F"), 25);
	assert.equal(normalizeIntervalMinutes("60.0"), 25);
});

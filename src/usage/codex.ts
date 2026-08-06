import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { currentWindowSamples } from "./burn-rate";
import { NoUsageDataError, type UsageReading } from "./types";

/** Number of minutes in the weekly rate-limit window Codex reports. */
const WEEKLY_WINDOW_MINUTES = 10080;

/** How many of the most recent rollout files to inspect before giving up. */
const MAX_FILES_SCANNED = 12;

/** Once the current window's samples span this long, scanning older rollouts adds nothing useful. */
const TARGET_HISTORY_SPAN_MS = 2 * 60 * 60 * 1000;

/** Nothing older than this informs a *recent* burn rate, so the scan stops once it reaches back this far. */
const MAX_LOOKBACK_MS = 12 * 60 * 60 * 1000;

/** Only the tail of a rollout is read; token_count events are appended, so the newest are at the end. */
const TAIL_BYTES = 512 * 1024;

/**
 * One window of a Codex `rate_limits` payload.
 */
type CodexRateLimitWindow = {
	used_percent?: number;
	window_minutes?: number;
	resets_at?: number;
};

/**
 * A single `rate_limits` observation pulled out of a rollout.
 */
type Observation = {
	usedPercent: number;
	resetsAt?: Date;
	at: Date;
};

/** The last reading, kept so an untouched rollout set does not have to be re-read. */
let cached: { fingerprint: string; reading: UsageReading } | undefined;

/**
 * Reads the most recent weekly rate-limit percentage Codex CLI recorded in `~/.codex/sessions`.
 *
 * Codex writes a `token_count` event carrying `rate_limits` on every turn, so a rollout holds a whole
 * series of observations, not just the latest — enough to estimate a burn rate without extra plumbing.
 */
export async function readCodexUsage(sessionsDir = path.join(os.homedir(), ".codex", "sessions")): Promise<UsageReading> {
	const files = await newestRollouts(sessionsDir);

	// While Codex sits idle the scan never accumulates enough span to stop early, so without this it
	// would re-read every rollout tail — megabytes — on each refresh, forever, to reproduce a reading
	// that cannot have changed. Codex only ever appends, so the newest rollout's size and mtime settle
	// the question.
	const fingerprint = await newestFingerprint(files[0]);
	if (fingerprint !== undefined && cached?.fingerprint === fingerprint) {
		return cached.reading;
	}

	const observations: Observation[] = [];

	for (const file of files) {
		observations.push(...(await readRolloutTail(file)));

		// Files are scanned newest first, so a wide enough span means older rollouts cannot improve it.
		// The lookback bound stops the scan when usage has been flat and no span will ever accumulate.
		if (currentWindowSpan(observations) >= TARGET_HISTORY_SPAN_MS || totalSpan(observations) >= MAX_LOOKBACK_MS) {
			break;
		}
	}

	if (observations.length === 0) {
		throw new NoUsageDataError("no rate_limits event found in recent Codex rollouts");
	}

	observations.sort((a, b) => a.at.getTime() - b.at.getTime());
	const latest = observations[observations.length - 1];

	const reading: UsageReading = {
		usedPercent: latest.usedPercent,
		resetsAt: latest.resetsAt,
		observedAt: latest.at,
		history: observations.slice(0, -1).map(({ at, usedPercent }) => ({ at, usedPercent }))
	};

	if (fingerprint !== undefined) {
		cached = { fingerprint, reading };
	}

	return reading;
}

/**
 * Identifies the state of the newest rollout, so an unchanged one can be recognised without reading it.
 */
async function newestFingerprint(file: string | undefined): Promise<string | undefined> {
	if (file === undefined) {
		return undefined;
	}

	try {
		const { size, mtimeMs } = await fs.stat(file);
		return `${file}:${size}:${mtimeMs}`;
	} catch {
		return undefined;
	}
}

/**
 * Time covered by the observations that belong to the *current* window.
 *
 * Measuring the whole collection instead would stop the scan as soon as it reached back past a reset,
 * leaving the current window with too few samples to estimate a burn rate from.
 */
function currentWindowSpan(observations: Observation[]): number {
	const samples = currentWindowSamples(observations.map(({ at, usedPercent }) => ({ at, usedPercent })));
	if (samples.length < 2) {
		return 0;
	}

	return samples[samples.length - 1].at.getTime() - samples[0].at.getTime();
}

/**
 * Time between the earliest and latest observation collected so far, resets included.
 */
function totalSpan(observations: Observation[]): number {
	if (observations.length < 2) {
		return 0;
	}

	const times = observations.map((o) => o.at.getTime());
	return Math.max(...times) - Math.min(...times);
}

/**
 * Lists the most recently written rollout files, newest first.
 *
 * Rollout file names embed an ISO-8601 timestamp (`rollout-2026-07-31T17-14-31-<id>.jsonl`), so sorting
 * by name is equivalent to sorting by start time and avoids stat-ing every file.
 */
async function newestRollouts(sessionsDir: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(sessionsDir, { encoding: "utf8", recursive: true, withFileTypes: true });
	} catch {
		throw new NoUsageDataError(`Codex sessions directory not found: ${sessionsDir}`);
	}

	return entries
		.filter((entry) => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl"))
		.sort((a, b) => b.name.localeCompare(a.name))
		.slice(0, MAX_FILES_SCANNED)
		.map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Collects every `rate_limits` observation in the tail of a single rollout.
 */
async function readRolloutTail(file: string): Promise<Observation[]> {
	let tail: string;
	try {
		const handle = await fs.open(file, "r");
		try {
			const { size } = await handle.stat();
			const start = Math.max(0, size - TAIL_BYTES);
			const buffer = Buffer.alloc(size - start);
			await handle.read(buffer, 0, buffer.length, start);
			// A non-zero start almost certainly lands mid-line; that fragment is dropped below.
			tail = buffer.toString("utf8");
			if (start > 0) {
				tail = tail.slice(tail.indexOf("\n") + 1);
			}
		} finally {
			await handle.close();
		}
	} catch {
		return [];
	}

	return tail
		.split("\n")
		.filter((line) => line.includes(`"rate_limits"`))
		.map(toObservation)
		.filter((observation): observation is Observation => observation !== undefined);
}

/**
 * Converts a rollout line into an observation, or `undefined` when it carries no weekly percentage.
 */
function toObservation(line: string): Observation | undefined {
	let record: any;
	try {
		record = JSON.parse(line);
	} catch {
		return undefined;
	}

	const limits = record?.payload?.rate_limits ?? record?.rate_limits ?? record?.payload?.info?.rate_limits;
	const weekly = pickWeeklyWindow(limits);
	// A `null` percentage would otherwise pass an `=== undefined` guard and render as 0% — the one
	// misreport a quota gauge must never make.
	if (typeof weekly?.used_percent !== "number" || !Number.isFinite(weekly.used_percent)) {
		return undefined;
	}

	// An observation with no usable time cannot be judged fresh and would enter the burn rate as a
	// same-instant sample, so it is dropped rather than dated to now.
	const at = new Date(record?.timestamp ?? NaN);
	if (Number.isNaN(at.getTime())) {
		return undefined;
	}

	return {
		usedPercent: weekly.used_percent,
		resetsAt: typeof weekly.resets_at === "number" ? new Date(weekly.resets_at * 1000) : undefined,
		at
	};
}

/**
 * Picks the window that best matches the weekly allowance.
 *
 * Codex reports `primary` and `secondary` windows without naming which is which, so the one whose
 * `window_minutes` is closest to a week is used; windows shorter than a day are ignored outright.
 */
function pickWeeklyWindow(limits: unknown): CodexRateLimitWindow | undefined {
	if (limits === null || typeof limits !== "object") {
		return undefined;
	}

	const candidates = [(limits as any).primary, (limits as any).secondary].filter(
		(window): window is CodexRateLimitWindow => window !== null && typeof window === "object"
	);

	const weekly = candidates
		.filter((window) => (window.window_minutes ?? 0) >= 1440)
		.sort((a, b) => Math.abs((a.window_minutes ?? 0) - WEEKLY_WINDOW_MINUTES) - Math.abs((b.window_minutes ?? 0) - WEEKLY_WINDOW_MINUTES));

	return weekly[0];
}

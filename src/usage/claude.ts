import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NoUsageDataError, type UsageReading, type UsageSample } from "./types";

/**
 * Directory holding the files written by `scripts/statusline-usage-snapshot.sh`.
 *
 * Claude Code does not persist rate-limit percentages anywhere on disk; it only pushes them to the
 * status line on stdin. The snapshot script is what turns that transient payload into files.
 */
export const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), ".claude", "ai-usage");

/** Latest observation. */
const SNAPSHOT_FILE = "claude.json";

/** One line per change in the weekly percentage, oldest first; the source of the burn-rate estimate. */
const HISTORY_FILE = "claude-history.jsonl";

/** Older history adds nothing to the estimate and the file is trimmed by the script anyway. */
const MAX_HISTORY_LINES = 400;

/**
 * Reads the weekly rate-limit percentage from the Claude Code status-line snapshot.
 */
export async function readClaudeUsage(dir = DEFAULT_CLAUDE_DIR): Promise<UsageReading> {
	const snapshotPath = path.join(dir, SNAPSHOT_FILE);

	let raw: string;
	try {
		raw = await fs.readFile(snapshotPath, "utf8");
	} catch {
		throw new NoUsageDataError(`Claude usage snapshot not found: ${snapshotPath}`);
	}

	let snapshot: any;
	try {
		snapshot = JSON.parse(raw);
	} catch {
		throw new NoUsageDataError(`Claude usage snapshot is not valid JSON: ${snapshotPath}`);
	}

	const weekly = snapshot?.seven_day;
	if (typeof weekly?.used_percentage !== "number" || !Number.isFinite(weekly.used_percentage)) {
		throw new NoUsageDataError("snapshot has no seven_day.used_percentage");
	}

	// Without a timestamp the reading cannot be judged fresh, and dating it to the epoch would render a
	// twenty-thousand-day "ago" caption. No usable time means no usable reading.
	const observedAt = new Date(snapshot?.updated_at ?? NaN);
	if (Number.isNaN(observedAt.getTime())) {
		throw new NoUsageDataError("snapshot has no usable updated_at");
	}

	return {
		usedPercent: weekly.used_percentage,
		resetsAt: toDate(weekly.resets_at),
		observedAt,
		history: await readHistory(path.join(dir, HISTORY_FILE))
	};
}

/**
 * Reads earlier observations, oldest first. A missing or unreadable history simply means no estimate.
 */
async function readHistory(historyPath: string): Promise<UsageSample[]> {
	let raw: string;
	try {
		raw = await fs.readFile(historyPath, "utf8");
	} catch {
		return [];
	}

	return raw
		.split("\n")
		.slice(-MAX_HISTORY_LINES)
		.flatMap((line) => {
			if (line.trim() === "") {
				return [];
			}

			try {
				const record = JSON.parse(line);
				const at = new Date(record?.updated_at ?? NaN);
				const usedPercent = record?.seven_day?.used_percentage;

				if (typeof usedPercent !== "number" || Number.isNaN(at.getTime())) {
					return [];
				}

				return [{ at, usedPercent }];
			} catch {
				return [];
			}
		});
}

/**
 * Parses a `resets_at`, which Claude Code reports as epoch seconds but which older snapshots may hold
 * as an ISO-8601 string.
 */
function toDate(value: unknown): Date | undefined {
	if (typeof value === "number") {
		return new Date(value * 1000);
	}

	if (typeof value === "string") {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}

	return undefined;
}

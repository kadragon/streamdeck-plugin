import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { currentWindowSamples, projectExhaustion } from "../src/usage/burn-rate";
import { readClaudeUsage } from "../src/usage/claude";
import { readCodexUsage } from "../src/usage/codex";
import { NoUsageDataError, type UsageReading } from "../src/usage/types";

test("Claude reader rejects invalid percentage, timestamp, and reset values", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streamdeck-claude-"));
	try {
		await fs.writeFile(path.join(directory, "claude.json"), JSON.stringify({
			seven_day: { used_percentage: 20, resets_at: "2026-08-10T12:00:00.000Z" },
			updated_at: "not-a-date"
		}));
		await assert.rejects(() => readClaudeUsage(directory), NoUsageDataError);

		await fs.writeFile(path.join(directory, "claude.json"), JSON.stringify({
			seven_day: { used_percentage: 101, resets_at: "not-a-date" },
			updated_at: "2026-08-06T12:00:00.000Z"
		}));

		await assert.rejects(() => readClaudeUsage(directory), NoUsageDataError);

		await fs.writeFile(path.join(directory, "claude.json"), JSON.stringify({
			seven_day: { used_percentage: 20, resets_at: "not-a-date" },
			updated_at: "2026-08-06T12:00:00.000Z"
		}));
		await fs.writeFile(path.join(directory, "claude-history.jsonl"), [
			JSON.stringify({ seven_day: { used_percentage: 101 }, updated_at: "2026-08-06T11:00:00.000Z" }),
			JSON.stringify({ seven_day: { used_percentage: 10 }, updated_at: "2026-08-06T11:30:00.000Z" })
		].join("\n"));

		const reading = await readClaudeUsage(directory);
		assert.equal(reading.resetsAt, undefined);
		assert.deepEqual(reading.history, [{ at: new Date("2026-08-06T11:30:00.000Z"), usedPercent: 10 }]);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("Codex reader drops invalid observations and preserves valid reset time", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streamdeck-codex-"));
	try {
		const rollout = path.join(directory, "rollout-2026-08-06T12-00-00-test.jsonl");
		const record = (usedPercent: number, timestamp: string, resetsAt: number | string) => JSON.stringify({
			timestamp,
			payload: {
				rate_limits: {
					primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt }
				}
			}
		});
		await fs.writeFile(rollout, [
			record(101, "2026-08-06T11:00:00.000Z", "bad"),
			record(20, "2026-08-06T12:00:00.000Z", Math.floor(Date.parse("2026-08-10T12:00:00.000Z") / 1000))
		].join("\n"));

		const reading = await readCodexUsage(directory);
		assert.equal(reading.usedPercent, 20);
		assert.equal(reading.observedAt.toISOString(), "2026-08-06T12:00:00.000Z");
		assert.equal(reading.resetsAt?.toISOString(), "2026-08-10T12:00:00.000Z");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("burn projection ignores samples before the latest reset", () => {
	const reading: UsageReading = {
		usedPercent: 30,
		observedAt: new Date("2026-08-06T12:00:00.000Z"),
		history: [
			{ usedPercent: 70, at: new Date("2026-08-05T12:00:00.000Z") },
			{ usedPercent: 10, at: new Date("2026-08-06T10:00:00.000Z") }
		]
	};

	const samples = currentWindowSamples([...reading.history, { usedPercent: reading.usedPercent, at: reading.observedAt }]);
	assert.deepEqual(samples.map((sample) => sample.usedPercent), [10, 30]);
	const projection = projectExhaustion(reading, new Date("2026-08-06T12:00:00.000Z"));
	assert.equal(projection?.percentPerHour, 10);
});


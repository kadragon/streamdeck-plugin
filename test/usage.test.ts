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

const NOW = new Date("2026-08-10T00:00:00.000Z");

/** Builds a JWT-shaped access token whose `exp` claim the reader can inspect without a network call. */
function accessToken(expiresAt: Date): string {
	const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt.getTime() / 1000) }), "utf8").toString("base64url");
	return `header.${payload}.signature`;
}

/** Writes an `auth.json` in the Codex CLI's own shape and returns its path. */
async function writeAuth(directory: string, expiresAt: Date): Promise<string> {
	const authPath = path.join(directory, "auth.json");
	await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: accessToken(expiresAt), account_id: "acct-1" } }));
	return authPath;
}

/** Writes one rollout observation, so the API path can be tested against a known history. */
async function writeRollout(directory: string, usedPercent: number, timestamp: string, resetsAt?: string): Promise<void> {
	await fs.writeFile(path.join(directory, "rollout-2026-08-06T12-00-00-test.jsonl"), JSON.stringify({
		timestamp,
		payload: {
			rate_limits: {
				primary: {
					used_percent: usedPercent,
					window_minutes: 10080,
					...(resetsAt === undefined ? {} : { resets_at: Math.floor(Date.parse(resetsAt) / 1000) })
				}
			}
		}
	}));
}

/** A `fetch` stand-in that answers with a fixed status and body, and records that it was called. */
function stubFetch(status: number, body: unknown): typeof fetch & { calls: number } {
	const state = { calls: 0 };
	const impl = async (): Promise<Response> => {
		state.calls += 1;
		return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
	};

	Object.defineProperty(impl, "calls", { get: () => state.calls });
	return impl as unknown as typeof fetch & { calls: number };
}

/** The usage endpoint's response shape, with the windows the test cares about. */
function usageBody(windows: { primary?: unknown; secondary?: unknown }): unknown {
	return { rate_limit: { primary_window: windows.primary ?? null, secondary_window: windows.secondary ?? null } };
}

async function withCodexDirectory(body: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streamdeck-codex-api-"));
	try {
		await body(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

test("Codex API reading wins over the rollout and keeps rollout observations as history", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({
			primary: { used_percent: 42, limit_window_seconds: 604800, reset_at: Math.floor(Date.parse("2026-08-14T00:00:00.000Z") / 1000) }
		}));

		const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(reading.usedPercent, 42);
		assert.equal(reading.observedAt.getTime(), NOW.getTime());
		assert.equal(reading.resetsAt?.toISOString(), "2026-08-14T00:00:00.000Z");
		assert.deepEqual(reading.history, [{ at: new Date("2026-08-09T00:00:00.000Z"), usedPercent: 20 }]);
	});
});

test("Codex API reading keeps the rollout reset time when the endpoint omits one", async () => {
	for (const reset_at of [undefined, "not-a-timestamp"]) {
		await withCodexDirectory(async (directory) => {
			const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
			await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z", "2026-08-13T00:00:00.000Z");

			const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: 42, limit_window_seconds: 604800, reset_at } }));
			const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
			assert.equal(reading.usedPercent, 42);
			assert.equal(reading.resetsAt?.toISOString(), "2026-08-13T00:00:00.000Z");
		});
	}
});

test("Codex API picks the window closest to a week", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({
			primary: { used_percent: 90, limit_window_seconds: 86400 },
			secondary: { used_percent: 33, limit_window_seconds: 604800 }
		}));

		const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(reading.usedPercent, 33);
	});
});

test("Codex API falls back to the rollout when the percentage is unusable", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		for (const usedPercent of [null, Number.NaN, 101]) {
			const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: usedPercent, limit_window_seconds: 604800 } }));
			const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
			assert.equal(reading.usedPercent, 20);
			assert.equal(reading.observedAt.toISOString(), "2026-08-09T00:00:00.000Z");
		}
	});
});

test("Codex API falls back to the rollout on HTTP 401", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		const fetchImpl = stubFetch(401, { detail: "unauthorized" });
		const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(reading.usedPercent, 20);
		assert.equal(fetchImpl.calls, 1);
	});
});

test("Codex API is never called with an expired access token", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-01T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: 42, limit_window_seconds: 604800 } }));
		const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(reading.usedPercent, 20);
		assert.equal(fetchImpl.calls, 0);
	});
});

test("Codex API failure never escapes as an exception", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		const timingOut = (async () => {
			throw new Error("The operation was aborted due to timeout");
		}) as unknown as typeof fetch;

		const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl: timingOut });
		assert.equal(reading.usedPercent, 20);
	});
});

test("Codex API alone yields a reading when no rollout exists", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		const sessionsDir = path.join(directory, "missing-sessions");

		const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: 42, limit_window_seconds: 604800 } }));
		const reading = await readCodexUsage(sessionsDir, { now: NOW, authPath, fetchImpl });
		assert.equal(reading.usedPercent, 42);
		assert.deepEqual(reading.history, []);

		await assert.rejects(() => readCodexUsage(sessionsDir), NoUsageDataError);
	});
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


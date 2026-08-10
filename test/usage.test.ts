import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { currentWindowSamples, projectExhaustion } from "../src/usage/burn-rate";
import { readClaudeUsage } from "../src/usage/claude";
import { readCodexUsage } from "../src/usage/codex";
import { defaultFetch, resetCodexUsageCache, type CodexApiFailure } from "../src/usage/codex-api";
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

		// A path that does not exist keeps the endpoint out of a rollout-only case: with no readable
		// credentials the reader never reaches the network.
		const reading = await readCodexUsage(directory, { now: NOW, authPath: path.join(directory, "absent-auth.json") });
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

/** A `fetch` stand-in that answers with a fixed status and body, recording calls and body cancellation. */
function stubFetch(status: number, body: unknown): typeof fetch & { calls: number; bodyCancelled: boolean; url?: string; init?: RequestInit } {
	const state: { calls: number; bodyCancelled: boolean; url?: string; init?: RequestInit } = { calls: 0, bodyCancelled: false };
	const impl = async (input: string, init: RequestInit): Promise<Response> => {
		state.calls += 1;
		state.url = input;
		state.init = init;
		return {
			ok: status >= 200 && status < 300,
			status,
			body: { cancel: async () => void (state.bodyCancelled = true) },
			json: async () => body
		} as unknown as Response;
	};

	Object.defineProperty(impl, "calls", { get: () => state.calls });
	Object.defineProperty(impl, "bodyCancelled", { get: () => state.bodyCancelled });
	Object.defineProperty(impl, "url", { get: () => state.url });
	Object.defineProperty(impl, "init", { get: () => state.init });
	return impl as unknown as typeof fetch & { calls: number; bodyCancelled: boolean; url?: string; init?: RequestInit };
}

/** Shifts the caller's clock, so cache and backoff behaviour can be tested without waiting. */
function later(from: Date, seconds: number): Date {
	return new Date(from.getTime() + seconds * 1000);
}

/** The usage endpoint's response shape, with the windows the test cares about. */
function usageBody(windows: { primary?: unknown; secondary?: unknown }): unknown {
	return { rate_limit: { primary_window: windows.primary ?? null, secondary_window: windows.secondary ?? null } };
}

async function withCodexDirectory(body: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "streamdeck-codex-api-"));
	// The API outcome is memoised in module state, so one case's answer would otherwise serve the next.
	resetCodexUsageCache();
	try {
		await body(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

test("Codex API reading wins over the rollout and keeps rollout observations as history", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T23:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({
			primary: { used_percent: 42, limit_window_seconds: 604800, reset_at: Math.floor(Date.parse("2026-08-14T00:00:00.000Z") / 1000) }
		}));

		const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(reading.usedPercent, 42);
		assert.equal(reading.observedAt.getTime(), NOW.getTime());
		assert.equal(reading.resetsAt?.toISOString(), "2026-08-14T00:00:00.000Z");
		assert.deepEqual(reading.history, [{ at: new Date("2026-08-09T23:00:00.000Z"), usedPercent: 20 }]);
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

test("Codex API reading ignores a rollout reset time that has already passed", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: 42, limit_window_seconds: 604800 } }));
		const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(reading.usedPercent, 42);
		assert.equal(reading.resetsAt, undefined);
	});
});

test("Codex API reading drops rollout samples older than the lookback window", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-04T00:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: 95, limit_window_seconds: 604800 } }));
		const reading = await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(reading.usedPercent, 95);
		assert.deepEqual(reading.history, []);
		assert.equal(projectExhaustion(reading, NOW), undefined);
	});
});

test("Codex API is re-polled at most once a minute", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T23:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: 42, limit_window_seconds: 604800 } }));
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(fetchImpl.calls, 1);

		const cached = await readCodexUsage(directory, { now: later(NOW, 30), authPath, fetchImpl });
		assert.equal(fetchImpl.calls, 1);
		assert.equal(cached.usedPercent, 42);

		await readCodexUsage(directory, { now: later(NOW, 61), authPath, fetchImpl });
		assert.equal(fetchImpl.calls, 2);
	});
});

test("Codex API backs off after a failure and cancels the unread body", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T23:00:00.000Z");

		const fetchImpl = stubFetch(401, { detail: "unauthorized" });
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });
		assert.equal(fetchImpl.calls, 1);
		assert.equal(fetchImpl.bodyCancelled, true);

		// One failure doubles the wait, so a retry a minute later is still held back.
		await readCodexUsage(directory, { now: later(NOW, 61), authPath, fetchImpl });
		assert.equal(fetchImpl.calls, 1);

		const reading = await readCodexUsage(directory, { now: later(NOW, 121), authPath, fetchImpl });
		assert.equal(fetchImpl.calls, 2);
		assert.equal(reading.usedPercent, 20);
	});
});

test("Codex API falls back to the rollout when the proxy environment is malformed", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T23:00:00.000Z");

		const previous = process.env.HTTPS_PROXY;
		process.env.HTTPS_PROXY = "not a url";
		try {
			const reading = await readCodexUsage(directory, { now: NOW, authPath });
			assert.equal(reading.usedPercent, 20);
			assert.equal(reading.observedAt.toISOString(), "2026-08-09T23:00:00.000Z");
		} finally {
			if (previous === undefined) {
				delete process.env.HTTPS_PROXY;
			} else {
				process.env.HTTPS_PROXY = previous;
			}
		}
	});
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

		// Without this the memoised success above is re-served and the rollout-only path is never taken.
		resetCodexUsageCache();
		await assert.rejects(
			() => readCodexUsage(sessionsDir, { now: NOW, authPath: path.join(directory, "absent-auth.json") }),
			NoUsageDataError
		);
	});
});

test("Codex API request carries the endpoint URL, the CLI's identity, and no cross-origin redirect", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: 42, limit_window_seconds: 604800 } }));
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });

		assert.equal(fetchImpl.url, "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(fetchImpl.init?.method, "GET");
		// A redirect would hand `chatgpt-account-id` to whatever host answered; `authorization` is the
		// only header the platform strips on its own.
		assert.equal(fetchImpl.init?.redirect, "error");

		const headers = fetchImpl.init?.headers as Record<string, string>;
		assert.match(headers.authorization, /^Bearer header\./);
		assert.equal(headers.originator, "codex_cli_rs");
		assert.match(headers["User-Agent"], /^codex_cli_rs\//);
		assert.equal(headers["chatgpt-account-id"], "acct-1");
	});
});

test("Codex API omits the account header when auth.json carries no account id", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = path.join(directory, "auth.json");
		await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: accessToken(new Date("2026-08-20T00:00:00.000Z")) } }));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		const fetchImpl = stubFetch(200, usageBody({ primary: { used_percent: 42, limit_window_seconds: 604800 } }));
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl });

		assert.equal((fetchImpl.init?.headers as Record<string, string>)["chatgpt-account-id"], undefined);
	});
});

test("Codex API reports each failure reason once per live attempt, never on a cache hit", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");
		const failures: CodexApiFailure[] = [];
		const onFailure = (failure: CodexApiFailure): void => void failures.push(failure);

		// An unreadable auth.json is reported as missing credentials, and the network is never reached.
		const unusedFetch = stubFetch(200, usageBody({ primary: { used_percent: 42, limit_window_seconds: 604800 } }));
		await readCodexUsage(directory, { now: NOW, authPath: path.join(directory, "absent-auth.json"), fetchImpl: unusedFetch, onFailure });
		assert.deepEqual(failures, [{ kind: "no-credentials" }]);
		assert.equal(unusedFetch.calls, 0);

		resetCodexUsageCache();
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl: stubFetch(503, { detail: "unavailable" }), onFailure });
		assert.deepEqual(failures.at(-1), { kind: "http-error", status: 503 });

		// The status survives a body-cancel that rejects; the operator must still see the 401.
		resetCodexUsageCache();
		const uncancellable = (async () => ({
			ok: false,
			status: 401,
			body: {
				cancel: async () => {
					throw new Error("stream already errored");
				}
			},
			json: async () => ({})
		})) as unknown as typeof fetch;
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl: uncancellable, onFailure });
		assert.deepEqual(failures.at(-1), { kind: "http-error", status: 401 });

		resetCodexUsageCache();
		const throwing = (async () => {
			throw new Error("The operation was aborted due to timeout");
		}) as unknown as typeof fetch;
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl: throwing, onFailure });
		assert.deepEqual(failures.at(-1), { kind: "network-error", message: "The operation was aborted due to timeout" });

		// A cause chain is flattened, so undici's uniform `fetch failed` still names the real reason.
		resetCodexUsageCache();
		const wrapped = (async () => {
			throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
		}) as unknown as typeof fetch;
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl: wrapped, onFailure });
		assert.deepEqual(failures.at(-1), { kind: "network-error", message: "fetch failed: connect ECONNREFUSED 127.0.0.1:1" });

		// A 200 whose body will not parse is a payload problem, not an unreachable endpoint.
		resetCodexUsageCache();
		const unparseable = (async () => ({
			ok: true,
			status: 200,
			body: { cancel: async () => undefined },
			json: async () => {
				throw new SyntaxError("Unexpected token '<'");
			}
		})) as unknown as typeof fetch;
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl: unparseable, onFailure });
		assert.deepEqual(failures.at(-1), { kind: "unreadable-body", message: "Unexpected token '<'" });

		resetCodexUsageCache();
		const nonsense = stubFetch(200, usageBody({ primary: { used_percent: null, limit_window_seconds: 604800 } }));
		await readCodexUsage(directory, { now: NOW, authPath, fetchImpl: nonsense, onFailure });
		assert.deepEqual(failures.at(-1), { kind: "invalid-body" });

		// The memoised failure stands for the backoff window, so the reason is not re-reported per tick.
		const reported = failures.length;
		await readCodexUsage(directory, { now: later(NOW, 30), authPath, fetchImpl: nonsense, onFailure });
		assert.equal(failures.length, reported);
	});
});

test("Codex API keeps its reading when the failure sink throws", async () => {
	await withCodexDirectory(async (directory) => {
		const authPath = await writeAuth(directory, new Date("2026-08-20T00:00:00.000Z"));
		await writeRollout(directory, 20, "2026-08-09T00:00:00.000Z");

		const reading = await readCodexUsage(directory, {
			now: NOW,
			authPath,
			fetchImpl: stubFetch(401, { detail: "unauthorized" }),
			onFailure: () => {
				throw new Error("logger exploded");
			}
		});

		assert.equal(reading.usedPercent, 20);
	});
});

test("default transport issues a real request through the shared dispatcher", async () => {
	// The module-level proxy agent is built on the first call and reads the proxy variables then, so a
	// machine-wide HTTP_PROXY would otherwise swallow a request to a loopback server. Both spellings
	// are set: undici resolves `no_proxy ?? NO_PROXY`, so a lowercase one on the host would win.
	const previous = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
	process.env.NO_PROXY = "127.0.0.1,localhost";
	process.env.no_proxy = "127.0.0.1,localhost";

	const received: { url?: string; header?: string } = {};
	const server = http.createServer((req, res) => {
		received.url = req.url;
		received.header = req.headers.originator as string | undefined;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});

	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;

		const response = await defaultFetch()(`http://127.0.0.1:${port}/wham/usage`, {
			method: "GET",
			headers: { originator: "codex_cli_rs" }
		});

		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true });
		assert.equal(received.url, "/wham/usage");
		assert.equal(received.header, "codex_cli_rs");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
		restoreEnv("NO_PROXY", previous.upper);
		restoreEnv("no_proxy", previous.lower);
	}
});

/** Puts one environment variable back, distinguishing "was unset" from "was empty". */
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

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


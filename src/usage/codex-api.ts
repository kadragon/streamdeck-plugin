import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

import { isUsagePercent, parseResetTimestamp } from "./types";

/** Usage-only endpoint the Codex CLI itself polls; it reports quota without consuming a model turn. */
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Codex CLI identifies itself with these; the endpoint is only served to its own client. */
const ORIGINATOR = "codex_cli_rs";
const USER_AGENT = "codex_cli_rs/0.147.0";

/** Seconds in the weekly rate-limit window the endpoint reports. */
const WEEKLY_WINDOW_SECONDS = 604800;

/** Shortest window that can plausibly be the weekly one; anything below is a burst limit. */
const MIN_WINDOW_SECONDS = 86400;

/** A refresh must never outlive its own tick, so the request is abandoned after this long. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Shortest gap between two requests, whatever refresh interval the keys are set to. Codex CLI polls at this rate. */
const MIN_REFETCH_MS = 60 * 1000;

/** Ceiling on the failure backoff, so a recovered endpoint is picked up again within a quarter hour. */
const MAX_BACKOFF_MS = 15 * 60 * 1000;

/**
 * One window of the `rate_limit` object the usage endpoint returns.
 *
 * Field names differ from the rollout payload: seconds here, minutes there.
 */
type ApiRateLimitWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
};

/**
 * The credentials the Codex CLI stores after an OAuth login.
 */
export type CodexAuth = {
	accessToken: string;
	accountId?: string;
};

/**
 * What the usage endpoint contributes to a reading; the observation time comes from the caller.
 */
export type CodexApiUsage = {
	usedPercent: number;
	resetsAt?: Date;
};

/**
 * Why one usage request produced no reading.
 *
 * Every failure still collapses to a rollout fallback, but the reason travels to the caller so a
 * permanently broken endpoint is visible in the log instead of looking like a healthy rollout-only
 * plugin. The status and message are carried because they are the two that distinguish a revoked
 * token from a payload change from a blocked network.
 */
export type CodexApiFailure =
	| { kind: "no-credentials" }
	| { kind: "http-error"; status: number }
	| { kind: "network-error"; message: string }
	| { kind: "unreadable-body"; message: string }
	| { kind: "invalid-body" };

/**
 * Flattens an error and its `cause` chain into one line.
 *
 * `undici` reports every transport failure as the same `TypeError: fetch failed` and puts the real
 * reason — DNS, `ECONNREFUSED`, a TLS chain error, or the bundled `http2.connect` breakage — on
 * `cause`. Reporting only the top message would make every network failure read identically, which
 * is the silence this whole diagnostic path exists to end.
 */
function describeError(err: unknown): string {
	const parts: string[] = [];
	let current: unknown = err;

	for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
		parts.push(current instanceof Error ? current.message : String(current));
		current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
	}

	return parts.join(": ");
}

/**
 * Options for {@link fetchCodexUsage}.
 */
export type CodexApiOptions = {
	/** Caller-supplied clock; the response carries no observation time and readers may not invent one. */
	now: Date;
	authPath?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	/**
	 * Reports why a request produced no reading. Called once per live attempt, never on a cache hit,
	 * so the existing backoff also caps how often a persistent failure is reported.
	 *
	 * This layer reads files and sockets only; the SDK logger belongs to the action that owns it.
	 */
	onFailure?: (failure: CodexApiFailure) => void;
};

/**
 * Proxy-aware dispatcher, created once and shared.
 *
 * Do not remove this as redundant: Node's global `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless the
 * process was *started* with `NODE_USE_ENV_PROXY=1`, which a Stream Deck plugin does not control. Behind
 * a proxy every request to the usage endpoint therefore times out and the plugin silently falls back to
 * the rollout files forever — measured on the author's network. `EnvHttpProxyAgent` reads the proxy
 * variables (and `NO_PROXY`) itself, so a direct connection is still used where the environment says so.
 *
 * One agent is kept module-wide because the endpoint is polled per refresh tick; an agent per request
 * would leak sockets.
 */
let proxyAgent: EnvHttpProxyAgent | undefined;

/**
 * The transport used when the caller injects none: `undici`'s fetch bound to the shared proxy agent.
 *
 * Exported so the transport itself can be exercised: every other test injects `fetchImpl`, which
 * leaves this wiring — the one part that has already broken in a bundle — covered only in production.
 */
export function defaultFetch(): typeof fetch {
	// `allowH2: false` is load-bearing, not a tuning knob. Rollup's CommonJS interop rewrites undici's
	// internal `require("node:http2")` into a binding whose `connect` is undefined, so the moment TLS
	// negotiates h2 the request dies with `TypeError: http2.connect is not a function` — swallowed here
	// into a silent, permanent fallback to the rollout files. It reproduces only in the bundle, never
	// when the source is run directly, which is why the test suite cannot see it. Pinning HTTP/1.1
	// avoids the broken code path entirely; the endpoint serves 1.1 fine.
	proxyAgent ??= new EnvHttpProxyAgent({ allowH2: false });
	const dispatcher = proxyAgent;

	return ((input: any, init: any) => undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;
}

/** Default location of the credentials the Codex CLI writes at login. */
export function defaultAuthPath(): string {
	return path.join(os.homedir(), ".codex", "auth.json");
}

/**
 * Loads the Codex CLI's own credentials, or `undefined` when they cannot be used.
 *
 * The access token is a JWT with a roughly ten-day lifetime. Checking `exp` locally keeps an expired
 * token from costing a network round-trip per refresh: the request could only ever come back 401, and
 * this plugin deliberately does not renew the token (running `codex` once makes the CLI do it).
 */
export async function readCodexAuth(authPath: string, now: Date): Promise<CodexAuth | undefined> {
	let parsed: any;
	try {
		parsed = JSON.parse(await fs.readFile(authPath, "utf8"));
	} catch {
		return undefined;
	}

	const accessToken = parsed?.tokens?.access_token;
	if (typeof accessToken !== "string" || accessToken === "") {
		return undefined;
	}

	if (isExpired(accessToken, now)) {
		return undefined;
	}

	const accountId = parsed?.tokens?.account_id;
	return { accessToken, accountId: typeof accountId === "string" && accountId !== "" ? accountId : undefined };
}

/** The last outcome, so a key ticking every second does not authenticate against the endpoint every second. */
let cache: { at: Date; value?: CodexApiUsage; failures: number } | undefined;

/**
 * Discards the memoised outcome.
 *
 * Exists for tests: the cache is module state, so without this one case's answer would leak into the next.
 */
export function resetCodexUsageCache(): void {
	cache = undefined;
}

/**
 * How long the previous outcome stands before the endpoint is asked again.
 *
 * A run of failures — a revoked token 401ing, or a 5xx — is not going to clear within a tick, so each
 * consecutive one doubles the wait instead of hammering the endpoint at full refresh rate.
 */
function reuseWindowMs(failures: number): number {
	return failures === 0 ? MIN_REFETCH_MS : Math.min(MIN_REFETCH_MS * 2 ** failures, MAX_BACKOFF_MS);
}

/**
 * Reads the current weekly usage from the endpoint, or `undefined` when it cannot be trusted.
 *
 * The answer is memoised: keys tick once a second and may be configured to refresh far faster than the
 * quota can move, so the request rate is pinned to {@link MIN_REFETCH_MS} — the interval the Codex CLI
 * itself polls at — regardless of how often this is called. Reuse is judged against the caller's clock,
 * never a wall clock, so the behaviour is deterministic under test.
 *
 * Every failure mode — missing credentials, non-200, network error, timeout, unparseable or invalid
 * body — collapses to `undefined` so the caller can fall back to the rollout files unchanged. This is
 * a best-effort freshness improvement, never a new way for a refresh to fail. The reason is handed to
 * {@link CodexApiOptions.onFailure} so the fallback is diagnosable rather than silent.
 */
export async function fetchCodexUsage(options: CodexApiOptions): Promise<CodexApiUsage | undefined> {
	if (cache !== undefined && options.now.getTime() - cache.at.getTime() < reuseWindowMs(cache.failures)) {
		return cache.value;
	}

	const { value, failure } = await requestCodexUsage(options);
	if (failure !== undefined) {
		try {
			options.onFailure?.(failure);
		} catch {
			// A diagnostics sink is not allowed to cost the caller its reading: throwing here would
			// abandon the rollout fallback too, which is the very silence this reporting exists to end.
		}
	}

	// A failure drops the previous value rather than re-serving it: it would be dated to the caller's
	// clock, and reporting an old percentage as current is worse than falling back to the rollouts.
	cache = { at: options.now, value, failures: value === undefined ? (cache?.failures ?? 0) + 1 : 0 };
	return value;
}

/**
 * Performs one usage request, absorbing every failure into a reported reason.
 */
async function requestCodexUsage(options: CodexApiOptions): Promise<{ value?: CodexApiUsage; failure?: CodexApiFailure }> {
	const auth = await readCodexAuth(options.authPath ?? defaultAuthPath(), options.now);
	if (auth === undefined) {
		return { failure: { kind: "no-credentials" } };
	}

	const headers: Record<string, string> = {
		authorization: `Bearer ${auth.accessToken}`,
		originator: ORIGINATOR,
		"User-Agent": USER_AGENT
	};
	if (auth.accountId !== undefined) {
		headers["chatgpt-account-id"] = auth.accountId;
	}

	// Each stage gets its own try, so a reason names the stage that actually failed: a body that will
	// not parse is a payload problem, not an unreachable endpoint, and the two have different fixes.
	let response: Response;
	try {
		// Building the default transport constructs a proxy agent, which throws on a malformed
		// HTTP_PROXY value; inside the try that stays a fallback to the rollouts, not a failed refresh.
		const doFetch = options.fetchImpl ?? defaultFetch();
		response = await doFetch(USAGE_URL, {
			method: "GET",
			headers,
			// `authorization` is stripped across origins but `chatgpt-account-id` is not, so a redirect
			// would hand the account id to whatever host answered. The endpoint has no reason to redirect.
			redirect: "error",
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
		});
	} catch (err) {
		return { failure: { kind: "network-error", message: describeError(err) } };
	}

	if (!response.ok) {
		// undici holds the connection until the body is read or collected; a token that 401s on every
		// refresh would otherwise accumulate sockets. A cancel that rejects must not overwrite the
		// status: the operator needs to know it was a 401, not that the endpoint was unreachable.
		await response.body?.cancel().catch(() => undefined);
		return { failure: { kind: "http-error", status: response.status } };
	}

	let body: any;
	try {
		body = await response.json();
	} catch (err) {
		return { failure: { kind: "unreadable-body", message: describeError(err) } };
	}

	const weekly = pickWeeklyWindow(body?.rate_limit);
	// A `null` percentage would otherwise pass an `=== undefined` guard and render as 0% — the one
	// misreport a quota gauge must never make.
	if (!isUsagePercent(weekly?.used_percent)) {
		return { failure: { kind: "invalid-body" } };
	}

	return {
		value: {
			usedPercent: weekly.used_percent,
			resetsAt: parseResetTimestamp(weekly.reset_at)
		}
	};
}

/**
 * Tells whether a JWT access token has passed its `exp` claim.
 *
 * A token whose payload cannot be read is treated as usable: the endpoint is the real authority, and
 * refusing to ask because of an unexpected token shape would break the feature for no gain.
 */
function isExpired(accessToken: string, now: Date): boolean {
	const segments = accessToken.split(".");
	if (segments.length < 2) {
		return false;
	}

	let payload: any;
	try {
		payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
	} catch {
		return false;
	}

	const exp = payload?.exp;
	return typeof exp === "number" && Number.isFinite(exp) && exp * 1000 <= now.getTime();
}

/**
 * Picks the window that best matches the weekly allowance.
 *
 * The endpoint names its windows `primary` and `secondary` without saying which allowance each covers,
 * so the one whose `limit_window_seconds` is closest to a week wins; sub-day windows are burst limits
 * and are ignored outright.
 */
function pickWeeklyWindow(rateLimit: unknown): ApiRateLimitWindow | undefined {
	if (rateLimit === null || typeof rateLimit !== "object") {
		return undefined;
	}

	const candidates = [(rateLimit as any).primary_window, (rateLimit as any).secondary_window].filter(
		(window): window is ApiRateLimitWindow => window !== null && typeof window === "object"
	);

	const weekly = candidates
		.filter((window) => (window.limit_window_seconds ?? 0) >= MIN_WINDOW_SECONDS)
		.sort(
			(a, b) =>
				Math.abs((a.limit_window_seconds ?? 0) - WEEKLY_WINDOW_SECONDS) -
				Math.abs((b.limit_window_seconds ?? 0) - WEEKLY_WINDOW_SECONDS)
		);

	return weekly[0];
}

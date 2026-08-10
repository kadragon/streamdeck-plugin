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
 * Options for {@link fetchCodexUsage}.
 */
export type CodexApiOptions = {
	/** Caller-supplied clock; the response carries no observation time and readers may not invent one. */
	now: Date;
	authPath?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
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
 */
function defaultFetch(): typeof fetch {
	proxyAgent ??= new EnvHttpProxyAgent();
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

/**
 * Reads the current weekly usage straight from the endpoint, or `undefined` when it cannot be trusted.
 *
 * Every failure mode — missing credentials, non-200, network error, timeout, unparseable or invalid
 * body — collapses to `undefined` so the caller can fall back to the rollout files unchanged. This is
 * a best-effort freshness improvement, never a new way for a refresh to fail.
 */
export async function fetchCodexUsage(options: CodexApiOptions): Promise<CodexApiUsage | undefined> {
	const auth = await readCodexAuth(options.authPath ?? defaultAuthPath(), options.now);
	if (auth === undefined) {
		return undefined;
	}

	const doFetch = options.fetchImpl ?? defaultFetch();
	const headers: Record<string, string> = {
		authorization: `Bearer ${auth.accessToken}`,
		originator: ORIGINATOR,
		"User-Agent": USER_AGENT
	};
	if (auth.accountId !== undefined) {
		headers["chatgpt-account-id"] = auth.accountId;
	}

	let body: any;
	try {
		const response = await doFetch(USAGE_URL, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
		});
		if (!response.ok) {
			return undefined;
		}

		body = await response.json();
	} catch {
		return undefined;
	}

	const weekly = pickWeeklyWindow(body?.rate_limit);
	// A `null` percentage would otherwise pass an `=== undefined` guard and render as 0% — the one
	// misreport a quota gauge must never make.
	if (!isUsagePercent(weekly?.used_percent)) {
		return undefined;
	}

	return {
		usedPercent: weekly.used_percent,
		resetsAt: parseResetTimestamp(weekly.reset_at)
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

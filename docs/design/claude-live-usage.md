# Claude Live Usage Endpoint — Spike Findings

Status: decided — option A (status-line snapshots only); no live client. Date: 2026-11-18.

Reopen only if stale Claude readings between sessions become a real problem; start from option C's
unattended `get_usage` check under *Unknowns*.

## Question

The Codex source reads live rate-limit utilization from `https://chatgpt.com/backend-api/wham/usage`
with the bearer token in `~/.codex/auth.json` (`src/usage/codex-api.ts`). The Claude source has no
equivalent: `src/usage/claude.ts` only reads status-line snapshots (`~/.claude/ai-usage/claude.json`
and the Herdr capture), so the key goes stale whenever no Claude Code session is rendering a status
line. Does Claude Code expose an equivalent endpoint and a local credential?

## Method

String inspection of the installed Claude Code binary (`~/.local/bin/claude.exe`, build dated
2026-11-18) with `grep -a`. No request was sent and the credential file was not read; the values
below are what the client code says, not an observed response.

## Findings

### Endpoint

- `GET https://api.anthropic.com/api/oauth/usage` — `BASE_API_URL` is `https://api.anthropic.com`;
  the client's `fetchUtilization` builds the path from a read mode. Variants seen:
  `?skip_spend=1` (used for the `windows` read mode), `?cedar_ember=1&skip_spend=1`,
  `?at_wall=1&skip_spend=1`. The plain path additionally reads spend data.
- Headers for OAuth logins: `Authorization: Bearer <accessToken>` and
  `anthropic-beta: oauth-2025-04-20`.
- The client re-sends once with a refreshed bearer after a `401` ("401 during another read's token
  refresh"). A third-party reader cannot refresh the token itself without reimplementing the OAuth
  refresh flow, so it would see `401` whenever the stored token has expired.

### Response shape (client-side schema)

Top-level buckets, each `{ utilization: number | null, resets_at: string | null }` where
`utilization` is "Percentage of the window used, 0-100" and `resets_at` is ISO 8601:

- `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`,
  `seven_day_overage_included`
- `extra_usage`: `{ is_enabled, monthly_limit, used_credits, utilization, currency }`
- `model_scoped`: per-model weekly windows with `display_name`, `utilization`, `resets_at`

`seven_day.utilization` maps directly onto `UsageReading.usedPercent`, and `seven_day.resets_at`
onto `resetsAt`; the status-line path already converts the same field
(`seven_day: { used_percentage: … seven_day.utilization }`). All buckets are nullable, so Golden
Principle 1 validation (`isUsagePercent`, `parseResetTimestamp`) is still required.

### Credential

Claude Code stores OAuth credentials under the `claudeAiOauth` key. On Windows and Linux this is
`~/.claude/.credentials.json` (present on this machine; contents not inspected); on macOS it is the
login Keychain. Reading it from the plugin means the plugin holds a second bearer token.

### Alternative: Agent SDK control request

The binary also exposes a `get_usage` control request (flagged experimental: "the response shape
may change") that returns the structured `/usage` data, including plan rate-limit utilization, with
a `skip_behaviors` flag intended for "a usage meter". Using it means spawning `claude` in SDK mode
and speaking its stream-JSON protocol, but the plugin never touches the token and Claude Code
handles refresh itself.

## Risks

- **Undocumented.** `/api/oauth/usage` is an internal endpoint of Claude Code, not a public API;
  its query flags are experiment-gated and the shape can change without notice.
- **Golden Principle 5.** Only `src/usage/codex-api.ts` may open a network client and hold a bearer
  token. `npm run check:principles` enforces only the network-client half (it matches client call
  shapes such as `fetch(`); reading or holding a credential is caught in review alone, and so is
  spawning a child process that makes the call. A direct client needs the principle widened to a
  second module and a second secret.
- **Token expiry.** No refresh in the plugin means the live read silently degrades to the snapshot
  path between Claude Code sessions — exactly when it would be most useful.

## Options

| Option | Network/secret change | Freshness when no session runs | Effort |
|---|---|---|---|
| A. Keep status-line snapshots only | none | stale | none |
| B. Direct `GET /api/oauth/usage` with the stored token | widen Principle 5 to a Claude API module | fresh until the token expires | medium |
| C. `get_usage` via a spawned `claude` SDK process | the plugin triggers egress through a child process; Principle 5 must be extended or explicitly waived, and `check:principles` cannot see it | expected fresh with Claude Code refreshing the token — unverified for unattended runs | medium–high, experimental protocol |

Recommendation: none of B or C is ready to pick. C avoids the plugin holding a token, but its
deciding advantage — fresh readings and token refresh with no interactive session — is unverified,
so first run the `get_usage` check under *Unknowns*. If it holds and the Principle 5 extension is
acceptable, prefer C; otherwise stay on A. B is the closest mirror of the Codex path but carries
both the policy change and the expiry gap.

## Unknowns

- [unknown — read a live `GET /api/oauth/usage` response to verify] the response matches the client
  schema.
- [unknown — read `~/.claude/.credentials.json` key names to verify] whether `expiresAt` is stored
  beside `accessToken`, which would let option B skip known-expired tokens.
- [unknown — read a `get_usage` reply from a spawned `claude` to verify] its latency, whether it works
  without an interactive session, and whether it refreshes an expired token.

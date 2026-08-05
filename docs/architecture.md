# Architecture

## Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (`package.json` declares `^5.2.2`) |
| Runtime | Node.js 24 in the Stream Deck manifest |
| SDK | `@elgato/streamdeck` |
| Build | Rollup with TypeScript, Node resolution, CommonJS, and Terser |
| Packaging | Stream Deck `.sdPlugin` manifest and generated `bin/plugin.js` |
| CI | GitHub Actions (`.github/workflows/quality.yml`) |

## Source Layout

```text
src/plugin.ts                  # SDK registration and wake-up refresh
src/actions/weekly-limit.ts    # Settings, lifecycle, ticker, source selection
src/render.ts                  # Pure SVG key-face rendering and time formatting
src/usage/types.ts             # Reading/sample contracts and no-data error
src/usage/burn-rate.ts         # Reset-aware burn-rate projection
src/usage/claude.ts            # Claude snapshot/history file reader
src/usage/codex.ts             # Codex rollout file reader and cache
scripts/statusline-usage-snapshot.sh
                               # Claude status-line stdin -> local snapshot/history
com.kadragon.aiusage.sdPlugin/
  manifest.json                # Stream Deck package contract
  ui/weekly-limit.html         # Property Inspector settings
  imgs/                        # Checked-in package artwork
  bin/                         # Generated build output; do not edit
```

## Layer Rules

### Dependency Direction

```text
plugin -> actions -> render
                  -> usage -> types
```

`src/usage/` must not depend on SDK/UI modules. `src/render.ts` is pure and must not read files or call SDK APIs. `src/plugin.ts` owns SDK connection and lifecycle wiring.

### Boundaries

- `WeeklyLimit` is the only action-level coordinator for settings, refresh cadence, and key updates.
- Usage readers return `UsageReading`; invalid or missing local data becomes `NoUsageDataError`.
- `renderKey` accepts a `KeyFace` and returns an SVG data URI; user-controlled caption text is escaped.
- The Property Inspector sends settings through Stream Deck events; the ticker uses the latest event payload rather than polling IPC.

## Data Access

The plugin makes no API calls. Claude data comes from `~/.claude/ai-usage/claude.json` and `claude-history.jsonl`; Codex data comes from `~/.codex/sessions/**/rollout-*.jsonl`. The shell wrapper creates the Claude files from status-line stdin and forwards the original payload to the configured status-line program.

## Key Abstractions

1. `UsageReading` — current percentage, observation time, optional reset, and prior samples.
2. `currentWindowSamples` — drops samples before the latest percentage decrease, treating it as a reset boundary.
3. `WeeklyLimit` — maps source/settings/lifecycle events to refresh and rendering.
4. `KeyFace` — render-only state for source branding, stale data, danger threshold, and burn warning.

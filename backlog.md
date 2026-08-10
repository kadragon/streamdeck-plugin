# Backlog

## System Monitor UI/UX

Spec: `docs/design/system-monitor-ux.md`. Ordered; A1 precedes B1.

### Track A — Key face redesign

- [x] [feat] A1 — Move the `network`/`gpu-power` full-scale values out of `systemMetricProgress`'s inline ternaries into one named table; add tests for clamping, the `undefined` path, and each full-scale mapping — `src/render.ts`, `test/render.test.ts`
- [x] [feat] A2 — Draw the magnitude gauge under the value on every metric, fed by `systemMetricProgress`; a missing reading renders no fill, a genuine `0` renders as present — `src/render.ts`, `test/render.test.ts`
- [x] [feat] A3 — Render the temperature chip on `cpu`/`gpu` from `SystemMonitorFace.temperatureC`, colour-matched to the background thresholds; absent when out of range or on metrics with no temperature — `src/render.ts`, `test/render.test.ts`
- [x] [feat] A4 — Move the status badge into the gauge row and give non-temperature metrics one stable neutral backdrop distinct from the unavailable backdrop — `src/render.ts`, `test/render.test.ts`
- [x] [feat] A5 — Show the GPU index in the header band when the metric is GPU-scoped and the index is not 0 — `src/render.ts`, `src/actions/system-metrics.ts`, `test/render.test.ts`

### Track B — Dial interaction

- [x] [feat] B1 — Export the shared metric order from `src/metrics/types.ts` matching the Property Inspector's option order; test that forward rotation round-trips and backward is its inverse — `src/metrics/types.ts`, `test/metrics.test.ts`
- [x] [feat] B2 — Implement `onDialRotate` to cycle `metric` through `setSettings`, debounced by rotation ticks; the settings-revision guard must still drop stale async renders — `src/actions/system-metrics.ts`
- [x] [feat] B3 — Implement `onDialDown` and `onTouchTap` as a forced re-sample via `refreshAll({ force: true })`, each terminating its own promise chain with a logged `.catch` — `src/actions/system-metrics.ts`
- [x] [feat] B4 — Add `layouts/system-monitor.json` (200×100, non-overlapping rects: label, value, `bar` with explicit range, status/temperature line) and switch `setFeedbackLayout` off `$B1`; verify with `npm run check:package` — `com.kadragon.aiusage.sdPlugin/layouts/system-monitor.json`, `src/actions/system-metrics.ts`, `com.kadragon.aiusage.sdPlugin/manifest.json`
- [x] [feat] B5 — Rewrite `TriggerDescription` to the real behaviour (`Push: Refresh now`, `Rotate: Change metric`, `Touch: Refresh now`) and update `README.md` / `docs/runbook.md` — `com.kadragon.aiusage.sdPlugin/manifest.json`, `README.md`, `docs/runbook.md`

## Deferred

- [ ] [feat] Investigate a live usage endpoint for the Claude source, as done for Codex via `wham/usage` — Claude Code persists no percentages of its own, so this needs a spike to find whether an equivalent endpoint and local credential exist — `src/usage/claude.ts`
- [ ] [feat] Multi-metric key (2–3 readings on one 144×144 face) — rejected in the current spec on glanceability grounds; revisit only with hardware evidence

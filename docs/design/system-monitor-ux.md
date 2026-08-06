# System Monitor UI/UX

## Problem Statement

`System Monitor` is now the plugin's primary display action, but its two faces under-serve the reading it produces.

The key face (`renderSystemMonitor` in `src/render.ts`) draws a metric label, a formatted value, and an optional status badge. It carries no magnitude cue, so a 12% and a 92% CPU key differ only in glyphs — unreadable in peripheral vision, which is the whole point of a hardware key. Temperature is encoded exclusively as a background tint on the `cpu` and `gpu` metrics; the actual °C is sampled and then discarded at render time, so the user can see "hot" but never "how hot". Every other metric renders on a flat neutral background, making the tint read as a metric-specific quirk rather than a consistent channel.

The dial face is worse: `manifest.json` advertises `Rotate: View metric` and `Touch: View metric`, but `onDialRotate`, `onDialDown`, `onDialUp`, and `onTouchTap` in `src/actions/system-metrics.ts` are deliberate no-ops. A Stream Deck+ user turns the dial, the Stream Deck software shows the advertised trigger description, and nothing happens. The dial also renders through the built-in `$B1` layout, whose single indicator is fed a percentage derived from arbitrary full-scale constants (1000 Mbps for `network`, 500 W for `gpu-power`) that match no property of the local machine.

## Solution

Two tracks, independently shippable, sharing one rule: the value, the magnitude, and the temperature are three distinct visual channels, and both faces must derive them from the same pure functions in `src/render.ts` so the key and the dial cannot drift apart.

### Track A — Key face redesign

Redesign the 144×144 key face around a fixed vertical rhythm:

- **Header band** — metric label, plus the GPU index when the metric is GPU-scoped and the index is not 0. The label stays legible at every state, including no-data.
- **Value line** — the formatted reading, auto-fitted as it is today. This remains the largest element.
- **Magnitude gauge** — a horizontal bar under the value, filled by `systemMetricProgress`. It gives the peripheral-vision read the current face lacks, and it is drawn for every metric, not only the percent-native ones.
- **Temperature chip** — a small right-aligned `NNc` chip on metrics that carry a temperature (`cpu`, `gpu`), replacing the discard of `reading.temperatureC`. The chip is colour-coded on the same thresholds as the background tint, so colour and number reinforce each other instead of colour standing alone.
- **Status badge** — `NO DATA` / `STALE` / `UNSUPPORTED` moves into the gauge row and suppresses the gauge fill, so a missing reading can never present as a zero-length bar that reads like a real low value.

Background tinting is kept but made consistent: temperature-bearing metrics keep the green/amber/red thresholds; every other metric gets one stable neutral backdrop, and the unavailable backdrop stays distinct from all of them.

Full-scale constants for the gauge move out of `systemMetricProgress`'s inline ternaries into a single named table so `network` and `gpu-power` scaling is one edit, reviewable and testable.

### Track B — Dial interaction

Make the dial do what the manifest already promises:

- **Rotate** cycles the selected metric through the same ordered list the Property Inspector offers, persisting the choice via `setSettings` so the key and the dial converge on one setting model. Rotation is debounced by rotation ticks, not by time, so a fast turn lands on a deterministic metric rather than a timing-dependent one.
- **Push (dial down)** forces an immediate re-sample, bypassing the sampler's interval cache — the same path `refreshAll({ force: true })` already takes on system wake.
- **Touch tap** performs the same forced refresh as push, so the touch strip and the dial agree.
- **`TriggerDescription`** is rewritten to state the real behaviour (`Push: Refresh now`, `Rotate: Change metric`, `Touch: Refresh now`).

The dial moves from `$B1` to a custom layout, `layouts/system-monitor.json`, on the 200×100 dial canvas: metric label, formatted value, a `bar` item fed by `systemMetricProgress`, and a status/temperature line. The layout is authored to the Stream Deck layout schema with non-overlapping item rects — `npm run check:package` runs `streamdeck validate`, which is the only check in this repository that rejects an overlapping-rect layout, and an overlap stops the dial from loading at runtime.

Every rotation and push handler stays inside the existing containment rule: no SDK callback may leak a rejected promise. Handlers that are `async` must terminate their own chain with `.catch` and a logged error.

## User Stories

- As a Stream Deck key user, I want to judge a metric's severity without reading digits, so that a glance at the deck tells me whether anything needs attention.
- As a Stream Deck key user, I want to see the actual CPU or GPU temperature, so that I can distinguish "warm" from "about to throttle" instead of inferring it from a colour.
- As a Stream Deck+ user, I want to turn the dial to change the displayed metric, so that one dial replaces the several keys I currently spend on CPU, RAM, and GPU.
- As a Stream Deck+ user, I want to push the dial for a fresh reading, so that I do not wait out the fifteen-second interval after starting a heavy job.
- As any user, I want a missing or stale reading to be unmistakable, so that I never act on a value that is not current.

## Implementation Decisions

- **Rendering stays pure.** `renderSystemMonitor` remains a pure function from a face description to an SVG data URI. No sampling, clock reads, or SDK calls enter `src/render.ts`.
- **One source of scale.** `systemMetricProgress` is the single definition of "how full is this metric", consumed by both the key gauge and the dial bar. The dial does not compute its own percentage.
- **Named full-scale table.** `network` (Mbps) and `gpu-power` (W) full-scale values become named constants in one table. Their current values (1000 and 500) are carried forward unchanged in this scope; changing them is a separate decision with its own evidence.
- **Temperature is data, not only styling.** `SystemMonitorFace.temperatureC` is rendered as a value on temperature-bearing metrics and continues to drive the background tint. Out-of-range temperatures fall back to the unavailable palette and render no chip, per the existing `isSystemTemperature` guard.
- **`not_observed != absent`.** A missing value renders `--` and a status badge with no gauge fill. Zero-length fill for a genuine zero is only drawn when the reading is present.
- **Settings are the single state.** Dial rotation writes `metric` through `setSettings`; the action does not hold a second, dial-only notion of the current metric. The existing settings-revision guard continues to drop stale async renders after a change.
- **Metric order is shared.** The rotation order is exported from `src/metrics/types.ts` and matches the Property Inspector's option order, so the two never diverge.
- **Custom dial layout.** `layouts/system-monitor.json` follows the Stream Deck layout schema, mirroring the item vocabulary (`text`, `bar` with an explicit `range`) proven by the removed usage-overview layout. `setFeedbackLayout` continues to be called before `setFeedback`.
- **No new dependency, no network.** Both tracks are SVG string construction and SDK calls only.

## Testing Decisions

Both tracks are verified by `node:test` through `tsx`, against pure functions — no Stream Deck runtime, no mocked SDK beyond what already exists.

1. **Key face states.** Decode the data URI and assert that ready, missing, stale, and unsupported states remain mutually distinguishable, extending the existing `test/render.test.ts` case rather than replacing it.
2. **Gauge fidelity.** Assert `systemMetricProgress` clamps to 0–100, returns `undefined` for an unusable reading, and maps the named full-scale values for `network` and `gpu-power`.
3. **Temperature chip.** Assert the chip is present with an in-range temperature on `cpu`/`gpu`, absent out of range, and absent on metrics that carry no temperature.
4. **Missing-vs-zero.** Assert a missing reading renders no gauge fill and that a genuine `0` does render as a present reading — the regression this design most needs to prevent.
5. **Rotation order.** Assert the exported metric order round-trips: rotating forward through its full length returns to the starting metric, and rotating backward is its inverse.
6. **Dial layout.** `npm run check:package` runs `streamdeck validate` over the package, which rejects overlapping item rects in `layouts/system-monitor.json`.

Manual verification, per `docs/runbook.md`: `streamdeck link`, then confirm on hardware that rotation changes the metric, push refreshes, and the advertised `TriggerDescription` matches observed behaviour.

## Out of Scope

- Multi-metric keys (two or three readings on one 144×144 face). Rejected for this scope: at key size the information density defeats the glanceability the redesign is meant to buy.
- Property Inspector changes — conditional GPU-index visibility, a configurable refresh interval, disk-drive selection. Tracked separately; the current PI stays functional throughout both tracks.
- New metrics, new sensors, and any change to `src/metrics/windows.ts` sampling behaviour. This design consumes the readings that exist.
- Changing the fifteen-second sample interval or the sampler's cache policy.
- Non-NVIDIA GPU support and non-Windows support.
- History, sparklines, or any retained time series. The action stays stateless between samples.

## Further Notes

Track A is self-contained in `src/render.ts` plus tests and can merge alone; the key face improves with no action-layer change. Track B depends on Track A only for `systemMetricProgress`'s named full-scale table, so if the tracks are split across sessions, Track A goes first.

The `TriggerDescription`/no-op mismatch is a user-visible correctness defect, not a polish item — if Track B is deferred, the manifest's trigger descriptions should be corrected to "No action" in the meantime rather than left advertising behaviour the plugin does not implement.

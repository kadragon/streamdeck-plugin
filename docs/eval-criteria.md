# Evaluation Criteria

Evaluation is evidence-first and separate from implementation when `qa-verifier` is delegated.

## Product Criteria

### 1. Usage correctness (weight: 35%)

Both sources show the latest valid weekly percentage, distinguish no data from zero, and exclude reset-crossing samples from burn-rate estimates.

| Score | Description |
|-------|-------------|
| 5 | Valid/invalid/missing values, reset boundaries, and stale readings all produce the intended state with focused evidence. |
| 4 | Correct normal and invalid input behavior; one minor edge case lacks evidence. |
| 3 | Normal path works and no known false-zero behavior exists; limited edge coverage. |
| 2 | At least one invalid or reset case can produce a misleading value. |
| 1 | Source selection or weekly percentage is broken. |

**How to test:** `npm run typecheck`; `npm run check:principles`; inspect reader fixtures or supplied local files and compare the resulting `UsageReading` fields.

### 2. Runtime resilience (weight: 25%)

Missing files, malformed payloads, SDK refresh failures, wake events, and concurrent wrapper runs must degrade without terminating the plugin or corrupting snapshots.

| Score | Description |
|-------|-------------|
| 5 | Each failure mode has a bounded fallback, logging path, or atomic write proof. |
| 4 | Runtime behavior is safe; one failure mode is verified only by review. |
| 3 | Expected missing data is safe; unusual failures are logged but not exercised. |
| 2 | A background rejection or partial write can terminate or mislead the plugin. |
| 1 | The plugin cannot stay running through normal source/tool absence. |

**How to test:** run `npm run build`, inspect callback `.catch()` boundaries, and run the wrapper with missing `jq`/downstream status-line fixtures where available.

### 3. Key UX and accessibility (weight: 20%)

The key face communicates source, percentage, stale state, alert state, reset countdown, and exhaustion warning without ambiguous captions.

| Score | Description |
|-------|-------------|
| 5 | Normal, stale, danger, no-data, and burn-warning states are visually distinct and fit the key. |
| 4 | States are clear with minor copy or sizing polish remaining. |
| 3 | Primary value and source are readable; one secondary state is weak. |
| 2 | Caption/state combinations can be misread. |
| 1 | The key does not communicate the current source/value. |

**How to test:** inspect `renderKey` output for all `KeyFace` states and manually view the linked Stream Deck action.

### 4. Packaging and operations (weight: 20%)

The manifest, generated bundle, property inspector, and setup docs agree.

| Score | Description |
|-------|-------------|
| 5 | CI checks type safety, build, principles, and generated package output; package links and validates where network permits. |
| 4 | Build and setup work; one optional Stream Deck validation is unavailable. |
| 3 | Build works and setup is documented; packaging still needs manual confirmation. |
| 2 | Manifest/build/docs drift or setup requires undocumented steps. |
| 1 | The package cannot be built or linked. |

**How to test:** `npm run check`, `npm run check:package`, then `streamdeck link com.kadragon.aiusage.sdPlugin` when Stream Deck is installed; run harness maintenance checks separately when the harness changes.

## Pass Threshold

- Every criterion is at least 3.
- Weighted average is at least 3.5.
- Any failed Sprint Contract item fails the cycle regardless of the average.

## Sprint Contract

```markdown
### Sprint Contract: {feature}

**Generator proposes:**
- I will build: {specific scope}
- Success looks like: {observable checks}
- Out of scope: {explicit exclusions}

**Agreed contract:**
- [ ] {criterion 1}
- [ ] {criterion 2}
- [ ] {criterion 3}
```

## Evaluator Protocol

1. Read the agreed criteria and relevant docs.
2. Run the stated commands and inspect the diff.
3. Record evidence before assigning scores.
4. Report omissions, risks, and failed criteria as backlog work.
5. Re-evaluate after fixes; do not grade implementation from memory.

Calibration: a score 5 has passing commands plus evidence for normal and failure states; a score 2 has a reproducible misleading value, missing failure handling, or package drift. Do not average away a failed contract item.

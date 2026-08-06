# Delegation

## Pattern Selection

```text
Q1. Are there 3+ genuinely independent units?
    No  -> work inline.
    Yes -> Q2.
Q2. Must agents share findings mid-flight?
    Yes -> Agent Teams only if explicitly enabled and coordination pays for its cost.
    No  -> sub-agent mode; return-value plus scratchpad artifacts.
Q3. Do phases have different coordination needs?
    Yes -> hybrid, but keep this repo's default to independent sub-agents.
```

Small, sequential, coupled edits stay inline. Team mode is not enabled in this repository.

## Routing Table

All triggers are countable or path-based. Global delegation policy remains the floor; rows are Optional.

| Trigger | Delegate to | Context | Gate |
|---------|-------------|---------|------|
| Scope spans at least 3 independent source units or >10 files | `explorer` | target paths, `docs/architecture.md`, task question | Optional |
| Approved Sprint Contract spans at least 3 files or 3 independent units | `implementer` | `tasks.md`, `docs/conventions.md`, owned paths | Optional |
| Diff spans at least 3 files or changes `manifest.json`, `rollup.config.mjs`, or `tsconfig.json` | `qa-verifier` | diff, Sprint Contract, `docs/eval-criteria.md` | Optional |

No role is required for a one-file or tightly coupled change. No router or critical-path edit gate exists; add either only after an observed miss or a user-approved risk decision.

## Spawn Prompt Contract

Every spawn prompt carries all four fields and an effort tier:

- **Objective:** exact question or acceptance criteria.
- **Output format:** report, verdict table, or diff summary.
- **Tools to use:** smallest useful allowlist.
- **Boundaries:** paths the role must not edit.
- **Effort tier:** `simple`, `comparison`, or `complex` with a call budget.

Named/background workers must report completion and artifact path to `main`, even when they find nothing. Return-value is the default for unnamed sub-agents.

## Data Transfer

| Need | Mechanism |
|------|-----------|
| Independent result | sub-agent return value |
| More than 20 lines or structured evidence | session scratchpad file |
| Within-session continuity | `handoff-{feature}.md` scratchpad file |
| Task state | `tasks.md` for active Sprint Contracts |

Scratchpad naming: `{phase:02d}_{agent}_{artifact}.{ext}`. The orchestrator resolves the path from its system prompt and embeds the full path in every spawn prompt. Artifacts are ephemeral.

## Context Manifests

### `explorer`

- Required: target paths, `docs/architecture.md`, the question to answer.
- Output: Files / Flow / Constraints / Recommended reads.
- Boundary: read-only; no Bash, Edit, or Write.

### `implementer`

- Required: approved `tasks.md` Sprint Contract, `docs/conventions.md`, owned paths, verification commands.
- Output: minimal diff plus one-line changed-file summary.
- Boundary: owned paths only; no self-evaluation.

### `qa-verifier`

- Required: modified paths/diff, done-when criteria, `docs/eval-criteria.md`.
- Output: criterion / pass-fail / evidence table plus risks.
- Boundary: production read-only; recommendations only.

## Error Policy

Retry a failed role once. If the retry fails, continue with the omitted result only when the lead can still verify the exit criteria; report the omission. If verification is unavailable, stop before claiming completion.

## Escalation

Escalate to an independent reviewer only after the same failure repeats twice and an available reviewer is named explicitly. Do not encode a model choice in role files or routing docs; the invoking platform selects it.

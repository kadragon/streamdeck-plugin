# Workflows

Choose one primary workflow per cycle. Smaller changes may stay inline when they do not meet the delegation bar in `docs/delegation.md`.

## `plan` — Spec Generation

1. Write `docs/design/{feature}.md` with user outcome, constraints, and phased scope.
2. Review the spec with the user before implementation.
3. Convert approved scope into one-line `backlog.md` items.

Skip for a change that fits one file and one observable check.

## `code` — Implementation

0. **Branch:** before a commit, leave `main`/`master`; use `feat/{slug}`, `fix/{slug}`, or `harness/{slug}`.
1. **Scope gate:** count files and independent source units. At 3+ independent units or 10+ files, optionally delegate `explorer` before editing.
2. **Sprint Contract:** write concrete done-when criteria before a backlog-driven implementation. Use the schema in `docs/eval-criteria.md`; `references/tasks-template.md` is the source template for `tasks.md` when a sprint starts.
3. **Implement:** use `implementer` for a qualifying approved Sprint Contract; otherwise edit inline. Keep changes inside declared ownership globs.
4. **QA gate:** for a diff spanning 3+ files or changing packaging/build config, delegate `qa-verifier` to read-only verification. The implementer must not grade its own work when verification is delegated.
5. **Feature evaluation:** check every done-when item and perform the manual Stream Deck/package check in `docs/eval-criteria.md`.
6. **Close:** run `npm run typecheck`, `npm run build`, and `npm run check:principles`; update docs only when behavior or an operational constraint changed.

Delegation is conditional and optional because the global operator policy keeps small, coupled work inline. No blocking delegation gate is installed.

## `draft` — Documentation

Read current code, then update `docs/` with claims tied to paths or commands. Do not change production code. Add a backlog item if the doc exposes missing behavior.

## `constrain` — Architectural Enforcement

1. Add or update a mechanical check in `scripts/check-principles.mjs` first.
2. Run it and `npm run typecheck`.
3. Document the boundary in `docs/architecture.md`.
4. Record existing violations as backlog work; do not hide them by weakening the check.

## `sweep` — Garbage Collection

1. Run `bash tools/sweep.sh` manually between features.
2. Review lint/principle output, doc drift, reference integrity, and harness freshness.
3. Fix trivial harness findings; put larger findings in `backlog.md` or active `tasks.md`.
4. Reassess whether each harness component still compensates for a real model limitation after model/tool upgrades.

Production code changes are not part of `draft` or `sweep`.

## `explore` — Research

State one question, inspect the relevant source/docs, and return options with evidence. Do not edit or commit. Feed an approved result into `plan` or `code`.

## `debate` — Competing Hypotheses

Not installed by default: Agent Teams is disabled. For a high-stakes bug that survives one diagnosis, use independent `explorer`/`qa-verifier` passes and report contradictions to the user instead of inventing consensus.

## Within-Session Handoff

For work approaching context limits or a role switch, write a scratchpad `handoff-{feature}.md` while context is fresh:

- Objective: user outcome, not a progress narrative.
- Completed Phases: concrete checked outcomes and artifact paths.
- Current Phase: one exact next action.
- Open Questions: short list with owner.
- Next Agent Contract: Objective, Output format, Tools to use, Boundaries.

Handoff artifacts are session-scoped; no cross-session resume is supported.

## Scratchpad and Sprint State

Intermediate artifacts use `{phase:02d}_{agent}_{artifact}.{ext}` under the session scratchpad directory supplied by the system prompt. `tasks.md` exists only during an active sprint; `backlog.md` remains the queue. Do not place scratchpad paths in the repository.

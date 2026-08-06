# Stream Deck Plugin Agent Rules

## Docs Index (read on demand)

| File | When to read |
|------|--------------|
| `docs/architecture.md` | Before changing source boundaries or adding modules |
| `docs/conventions.md` | Before editing TypeScript, UI, or shell integration |
| `docs/workflows.md` | At the start of a plan, code, draft, constrain, sweep, or explore cycle |
| `docs/delegation.md` | Before delegating or selecting an orchestrator pattern |
| `docs/eval-criteria.md` | Before QA or feature-complete evaluation |
| `docs/runbook.md` | For setup, build, validation, sweep, and failure recovery |
| `docs/harness-log.md` | When changing harness roles, skills, or enforcement |

## Golden Principles

Enforcement: `npm run check:principles`, `npm run typecheck`, build, CI, and QA workflow.

1. **Reject untrusted readings** — usage percentages must be finite numbers and timestamps must be usable before entering `UsageReading`.
2. **Contain async failures** — SDK wake/ticker callbacks must catch and log rejected promises; no background rejection may terminate the plugin.
3. **Keep data local** — plugin source reads local tool files and does not add network clients or API calls.
4. **Build from source** — package output is generated from `src/`; edit source, manifest, or UI, then run `npm run build`.
5. **Preserve evidence integrity** — `not_observed != absent`; write `[unknown — read {source} to verify]` instead of inventing values.

## Delegation

Inline is default. Apply the global delegation bar: delegate when work involves 10+ files, 3+ independent units, output that would flood this context, or work that outlives it. Optional roles below never block a permitted inline change.

| Trigger (objective) | Delegate | Mode | Gate |
|---------------------|----------|------|------|
| Scope spans at least 3 independent source units or more than 10 files | `explorer` | sub-agent | Optional |
| Backlog item has an approved Sprint Contract spanning at least 3 files or 3 independent units | `implementer` | sub-agent | Optional |
| Diff spans at least 3 files or changes `manifest.json`, `rollup.config.mjs`, or `tsconfig.json` | `qa-verifier` | sub-agent | Optional |

Use `code-orchestrator` for qualifying code work. No trigger router, critical-path gate, or Agent Teams is installed; add one only after measured failure evidence. Spawn prompts require Objective, Output format, Tools to use, and Boundaries.

<!-- harness:verbatim — mandated block, exempt from the non-inferability filter. Do not trim or paraphrase. -->
## Token Economy

Rules that apply every message — keep the context window lean.

1. Do not re-read a file already read in this session. If you need to check a change, read only the diff/region.
2. Do not call tools just to confirm information you already have. Simple questions deserve direct answers.
3. Run independent tool calls in parallel (multiple reads, grep + glob, etc.) — not sequentially.
4. Delegate any analysis that would produce >20 lines of output to a sub-agent; return only the conclusion to this context.
5. Do not restate what the user just said. They can read their own message.

## Working with Existing Code

| | |
|---|---|
| ✅ | Modify source-of-truth files; run `npm run typecheck`, `npm run build`, and `npm run check:principles`. |
| ⚠️ | Confirm scope before changing manifest behavior, dashboard URLs, runtime integration, or external release metadata. |
| 🚫 | Edit generated `com.kadragon.aiusage.sdPlugin/bin/` directly, commit to `main`, store secrets, or push/deploy without explicit user approval. |

## Language Policy

- Agent narration: Korean.
- Code, comments, commits, and repository docs: English.
- Product UI strings are currently English; change them only as part of an explicit feature scope.

## Platform Pointers

- Claude Code / Codex: `AGENTS.md` (this file)
- Claude-only project skills: `.claude/skills/`

<!-- harness:verbatim — mandated block, exempt from the non-inferability filter. Do not trim or paraphrase. -->
## Maintenance

Update this file **only** when ALL of the following are true:

1. Information is not directly discoverable from code / config / manifests / docs
2. It is operationally significant — affects build, test, deploy, or runtime safety
3. It would likely cause mistakes if left undocumented
4. It is stable and not task-specific

**Never add:** architecture summaries, directory overviews, style conventions
already enforced by tooling, anything already visible in the repo, or
temporary / task-specific instructions.

Prefer modifying or removing outdated entries over appending. When unsure, add
a short inline `TODO:` comment rather than inventing guidance.

Size budget: target ~100 lines, hard warn >200. Move long content to
`docs/*.md` (read on demand, cross-tool) and leave a pointer line here. On a
Claude-Code-only repo you may instead use `.claude/rules/*.md` (path-scoped,
auto-loads when the matching area is touched); on a multi-tool repo keep the
content in `docs/` so Codex/Cursor see it too.

**Memory boundary:** durable code/repo facts live here, in `.claude/rules/`, and
`docs/` — human-authored and version-controlled. Claude Code's auto-memory
(`MEMORY.md`) holds the model's discovered preferences and cross-session
learnings only; never promote a code fact into auto-memory, and don't hand-edit
`MEMORY.md`.

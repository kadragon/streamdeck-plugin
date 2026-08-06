---
name: code-orchestrator
description: |
  ALWAYS invoke this skill for code work spanning at least 3 independent source units, more than 10 files, or an approved implementation Sprint Contract. Do NOT inline-execute qualifying work. Trigger phrases (Korean + English): "코드 작업", "기능 구현", "버그 수정", "리팩터링", "run code", "start implementation", "fix this", "refactor". Skip only when the user explicitly says "inline", "직접", or "without orchestrator". No cross-session resume; scratchpad artifacts end with the session.
---

# Code Orchestrator

Coordinate qualifying code work through independent sub-agents. Small, coupled changes remain inline under the repository's global delegation policy.

## Phase 1: Preparation

1. Determine the scratchpad directory from the system prompt; never guess it.
2. Read \`docs/architecture.md\`, \`docs/conventions.md\`, \`docs/delegation.md\`, and \`docs/runbook.md\`.
3. Count changed files and independent source units. Decide whether the scope gate fires.
4. Declare ownership globs before spawning more than one worker. \`qa-verifier\` is read-only for production paths.

Artifact names use \`{phase:02d}_{agent}_{artifact}.{ext}\`. Embed the full resolved scratchpad path in every spawn prompt.

## Phase 2: Explore (conditional sub-agent)

When the scope gate fires, spawn \`explorer\` with all four fields:

\`\`\`text
Objective: map {target paths} for {task question}
Output format: Files / Flow / Constraints / Recommended reads report at {scratchpad}/01_explorer_map.md
Tools to use: Read, Grep, Glob
Boundaries: read-only; do not edit, write, or run Bash
Effort tier: simple
Save output to: {scratchpad}/01_explorer_map.md
Report completion and artifact path to main, even if no findings.
\`\`\`

Read the returned report before implementation. If the worker fails, retry once; then continue only if the lead can establish the same facts from primary files and record the omission.

## Phase 3: Implement

For an approved Sprint Contract meeting the threshold, spawn \`implementer\`; otherwise implement inline after the scope gate. Pass:

\`\`\`text
Objective: implement {backlog item} against {tasks.md Sprint Contract}
Output format: minimal diff, changed-file summary, and verification results at {scratchpad}/02_implementer_result.md
Tools to use: Read, Edit, Write, Grep, Glob, Bash
Boundaries: {ownership globs}; do not edit generated bin/ or self-evaluate
Effort tier: simple or comparison, with reason
Save output to: {scratchpad}/02_implementer_result.md
Report completion and artifact path to main, even if blocked.
\`\`\`

No worker crosses declared ownership without lead approval. A blocked worker returns a concrete question, not a guessed value.

## Phase 4: Verify

When the QA trigger fires, spawn \`qa-verifier\` after implementation is complete. It must receive the diff, contract, and full scratchpad path:

\`\`\`text
Objective: verify {changed paths} against {Sprint Contract}
Output format: criterion / pass-fail / evidence table at {scratchpad}/03_qa-verifier_report.md
Tools to use: Read, Grep, Glob, Bash
Boundaries: production read-only; do not apply fixes
Effort tier: simple
Save output to: {scratchpad}/03_qa-verifier_report.md
Report completion and artifact path to main, including an empty finding set.
\`\`\`

Run \`npm run typecheck\`, \`npm run build\`, and \`npm run check:principles\` as applicable. The lead applies fixes, then requests a fresh verification pass.

## Error Policy

Retry each failed worker once. After a second failure, report the omitted artifact and do not claim completion unless the lead can independently satisfy the exit criteria. Repeated failure twice routes to the user with evidence; this repository has no installed deep-debugger role.

## Phase 5: Close

1. Read all returned reports and scratchpad artifacts.
2. Confirm ownership, checks, and done-when criteria.
3. Update the owning docs only when a stable operational fact changed.
4. Report changed paths, checks, omissions, and remaining questions.

No cross-session resume. Scratchpad artifacts are ephemeral. No shared task pool is used; if future team mode introduces one, each worker must \`TaskGet\`, claim with \`TaskUpdate\`, complete, write its artifact, and message the orchestrator.

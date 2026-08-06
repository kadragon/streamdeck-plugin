# CI Quality Gate

## Problem Statement

The repository already has a GitHub Actions workflow, but its CI contract is implicit: one quality job runs the local checks without an explicit package-output assertion or a documented boundary between mandatory CI checks and desktop/network-only operations. Pull requests need a repeatable, read-only quality gate that proves the source can be checked and the Stream Deck package can be built without attempting release-side effects.

## Solution

Keep GitHub Actions as the CI platform and extend `.github/workflows/quality.yml` into the repository's PR/main quality gate.

The workflow will:

- run for pull requests and pushes to `main`;
- use Ubuntu with Node.js 24, matching the package runtime contract;
- install exactly from `package-lock.json` with `npm ci`, using the npm cache;
- run the canonical `npm run check` contract, covering type safety, golden-principle checks, and the Rollup build;
- validate the generated Stream Deck package after the build, including `manifest.json`'s `CodePath`, `bin/plugin.js`, and the emitted package metadata;
- cancel stale runs for the same pull request or branch and grant the workflow only `contents: read` permissions.

The workflow remains a single job with named steps. The checks share one dependency installation and one build, while separate step boundaries make failures diagnosable in GitHub Actions. Package-output validation should be exposed as a reusable npm script so local verification and CI use the same rule.

## User Stories

- As a contributor, I want every pull request to run the repository's quality checks, so that broken source changes are caught before merge.
- As a maintainer, I want pushes to `main` to prove the merged tree remains buildable, so that the default branch does not drift from the documented verification contract.
- As a maintainer, I want CI to avoid release and remote validation side effects, so that ordinary pull requests remain safe for fork-based contributions.

## Implementation Decisions

- **Trigger boundary:** `pull_request` and `push` to `main`. No release, tag, schedule, or deployment trigger in this scope.
- **Runner:** `ubuntu-latest`. The checks are Node-based; Stream Deck linking and desktop UI validation require a local host and are not portable CI checks.
- **Node and dependencies:** Node.js 24 via `actions/setup-node`; `npm ci` from the committed lockfile; npm cache keyed by the lockfile.
- **Canonical checks:** retain `npm run check` as the local aggregate contract rather than duplicating its command list in YAML. Add a package-output check as a separate npm script because the current principle check validates manifest structure but does not explicitly assert every generated build file exists.
- **Package contract:** verify that the build creates `com.kadragon.aiusage.sdPlugin/bin/plugin.js` and the emitted `bin/package.json`, and that the manifest still points to `bin/plugin.js`.
- **Workflow safety:** set read-only repository permissions and use concurrency cancellation. No secrets, write tokens, external API clients, `streamdeck link`, or `streamdeck validate` in the PR/main gate.
- **Generated files:** build output remains ignored and source-generated; it is validated in-place during the CI job and is not a new source of truth.
- **Failure policy:** every quality and package-output step is blocking. Harness maintenance, optional desktop linking, and Elgato remote validation remain manual operations described in `docs/runbook.md`.

## Testing Decisions

Correctness is verified by the following CI contract:

1. `npm ci` succeeds from the committed lockfile.
2. `npm run check` exits 0.
3. The package-output check exits 0 and confirms the generated bundle and package metadata exist and match the manifest entry point.

Local verification remains `npm run check` followed by the package-output check. Manual harness validation, `streamdeck link`, key interaction, and `streamdeck validate` remain outside CI because they need maintenance context, a desktop Stream Deck environment, or Elgato network access.

## Out of Scope

- Automatic publishing, release packaging, tag-based releases, or deployment.
- Stream Deck CLI linking or remote `streamdeck validate` in GitHub-hosted runners.
- A Windows/macOS runner matrix; desktop UI validation remains a local/manual concern.
- Dependency update automation, vulnerability scanning policy, and scheduled maintenance workflows.
- Harness structural validation and sweep execution in GitHub Actions; these remain manual maintenance commands.
- A new product test framework; existing typecheck, principle, and build checks remain the verification foundation.

## Further Notes

The current workflow already covers most of this contract. Implementation should be incremental: add the reusable package-output check, make the workflow's step names and safety settings explicit, then verify the workflow locally as far as the available environment allows. Update `docs/runbook.md` only if command names or CI/manual boundaries change; update `docs/eval-criteria.md` if package-output evidence becomes a formal evaluation item.

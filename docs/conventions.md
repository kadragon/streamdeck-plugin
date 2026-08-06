# Conventions

## Naming and Layout

| Element | Pattern | Example |
|---------|---------|---------|
| TypeScript files | lowercase kebab or feature name | `weekly-limit.ts`, `burn-rate.ts` |
| Exported functions | camelCase, verb-led | `readCodexUsage`, `projectExhaustion` |
| Types | PascalCase | `UsageReading`, `KeyFace` |
| Constants | UPPER_SNAKE_CASE for module constants | `DEFAULT_REFRESH_SECONDS` |
| Stream Deck UUIDs | `com.kadragon.aiusage.*` | `com.kadragon.aiusage.limit` |
| Shell variables | UPPER_SNAKE_CASE | `SNAPSHOT_DIR` |

## Code Style

### Imports

Order imports as standard-library modules, external packages, then relative modules. Keep type-only imports explicit with `import type` when the import is type-only.

### Error Handling

- Use `NoUsageDataError` for expected missing, malformed, or unusable local usage data.
- The action renders `no data` for that expected condition and logs unexpected reader/SDK failures.
- Never turn a missing timestamp or non-finite percentage into a default value that looks current.
- Async event/timer callbacks must handle rejected promises at their boundary.

### Async Patterns

- Prefer `async`/`await` for filesystem and SDK calls.
- Keep the shared ticker alive only while visible keys exist.
- Cache only when the source fingerprint proves the underlying rollout has not changed.
- Use atomic, process-specific temporary files in the status-line wrapper.

## Framework-Specific Rules

### Stream Deck SDK

- Register actions in `src/plugin.ts`; action lifecycle behavior belongs in `src/actions/`.
- Treat `WillAppear`/settings events as the settings source of truth; do not add per-tick `getSettings()` calls.
- Clear the native title when the SVG face renders the complete key content.
- Keep `openUrl` behavior in the action; default dashboard URLs live beside action settings.

### Local Usage Payloads

- Parse JSON at the reader boundary and validate the exact fields consumed.
- Weekly Codex selection is based on `window_minutes`, not object position alone.
- Burn-rate samples must be reset-aware and need both a minimum span and minimum rise.

### SVG Rendering

- Keep rendering pure and deterministic for the same `KeyFace`.
- Escape `&`, `<`, and `>` before inserting captions or labels into SVG text nodes.
- Preserve source branding while using danger/stale colors only for the corresponding state.

## Shell Integration

- Keep `scripts/*.sh` LF-normalized; `.gitattributes` enforces this.
- Preserve status-line stdin unchanged after snapshotting.
- Use `set -uo pipefail`; tolerate missing optional tools such as `jq` and `claude-hud` without erasing a prior snapshot.

## Git Conventions

Commit messages use `[TYPE] description` with types such as `FEAT`, `FIX`, `REFACTOR`, `TEST`, `CONSTRAINT`, `DOCS`, and `HARNESS`. Never commit directly to `main`; create a task branch before committing.

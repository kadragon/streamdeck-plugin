# Runbook

## Quick Start

### Prerequisites

- Node.js 24 for the Stream Deck package (`node --version`)
- npm (`npm --version`)
- Stream Deck CLI available as `streamdeck` for linking/validation
- Bash and `jq` for the Claude status-line wrapper and harness scripts

### Setup

```bash
npm install
npm run check
streamdeck link com.kadragon.aiusage.sdPlugin
```

Configure Claude Code's status line to call:

```text
bash /c/dev/stream-deck-plugin/scripts/statusline-usage-snapshot.sh
```

The wrapper writes `~/.claude/ai-usage/claude.json` and `claude-history.jsonl`, then forwards stdin to the latest `claude-hud` plugin when available.

### Warp agent attention

Build and link the plugin, then add an Agent Attention action for each fixed Warp tab slot. Start each
interactive agent through `scripts/agent-wrap.mjs`:

```powershell
node C:/dev/stream-deck-plugin/scripts/agent-wrap.mjs --source claude --tab 1 -- claude
node C:/dev/stream-deck-plugin/scripts/agent-wrap.mjs --source codex --tab 2 -- codex
```

Merge `scripts/claude-agent-hooks.example.json` into `~/.claude/settings.json` and
`scripts/codex-agent-hooks.example.json` into `~/.codex/hooks.json`, replacing the placeholder script
path with this repository's absolute path. The hook process inherits the wrapper's slot/runtime
environment. `AGENT_ATTENTION_STATE_DIR` overrides the shared local event directory when WSL or another
agent environment cannot see the plugin's default home directory.

The focus adapter uses `Ctrl+1` through `Ctrl+8` on Windows and `Cmd+1` through `Cmd+8` on macOS. On
Windows it keeps Warp maximized before selecting the tab; macOS leaves the current window mode
unchanged. System Events may require Accessibility permission. v1 does not support dynamic tab
discovery, tab 9, multiple Warp windows, or tab reordering.

### Warp Tab Config launcher

Add the **Warp Tab Config** action, choose one saved config in its Property Inspector, and press the key
to open that config as a new Warp tab. The selector reads local `.toml` files from Warp's `tab_configs`
directory and uses the filename stem for the Warp URI. Use the selector's refresh button after adding or
renaming a config.

On Windows, the stable directory is `%APPDATA%\\warp\\Warp\\data\\tab_configs\\`; macOS uses
`~/.warp/tab_configs/`; Linux uses `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/`.
Preview configs are listed when present and use Warp's `warppreview://` URI scheme.

### Verify

- `npm run typecheck` exits 0.
- `npm run build` creates `com.kadragon.aiusage.sdPlugin/bin/plugin.js`.
- `streamdeck link` installs the package; press a configured key after the corresponding source has produced local data.

## Build and Check

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript check without emitting |
| `npm run build` | Rollup production bundle |
| `npm run check:principles` | Golden-principle structural checks with agent-readable fixes |
| `npm run test:agent-attention` | Wrapper, hook classification, and atomic event-spool smoke checks |
| `npm run check` | Typecheck, principle checks, Agent Attention smoke checks, and build |
| `npm run watch` | Watch/rebuild and restart the linked plugin |
| `streamdeck validate` | Remote Stream Deck package validation; requires network access |

## Tests

There is no product test suite yet. Treat `npm run typecheck`, `npm run check:principles`, the build, and the manual source/packaging checks in `docs/eval-criteria.md` as the current verification contract. Add focused tests before changing reader or burn-rate behavior.

## Harness Operations

| Command | Purpose |
|---------|---------|
| `bash scripts/validate-harness.sh` | Structural harness validation and maturity report |
| `bash tools/sweep.sh` | Manual five-check harness sweep |
| `bash tools/sweep.sh --quick` | Principle check only |
| `python scripts/reconcile-harness.py` | Reconcile an active `tasks.md` sprint into `backlog.md` |
| `bash scripts/sync-claude-md.sh` | Repair the pure `CLAUDE.md` pointer |
| `bash scripts/symlink-guard.sh` | Repair `.agents/skills` |
| `bash scripts/check-context-size.sh` | Warn on an oversized always-loaded instruction file |

## Deployment

There is no automated publish/deploy workflow. Build and link the local `.sdPlugin` directory with Stream Deck CLI. Run `streamdeck validate` only when network access to Elgato is available.

## Common Failures

### Claude key shows `no data`

**Cause:** The status-line wrapper has not received a payload with `seven_day.used_percentage`, or `jq` is unavailable.

**Fix:** Run Claude Code once with the wrapper configured; install/verify `jq`; inspect `~/.claude/ai-usage/claude.json`.

### Reading is stale

**Cause:** The source tool has not written a fresh observation for six hours.

**Fix:** Run the source tool and let its reader produce a new observation. Stale means old data, not zero usage.

### Build output is missing

**Cause:** `npm run build` was not run or `node_modules` is absent.

**Fix:** Run `npm install`, then `npm run check`; do not hand-edit `com.kadragon.aiusage.sdPlugin/bin/`.

### Harness validation warns about executable line endings

**Cause:** A shell/Python file was saved with CRLF.

**Fix:** Preserve the `.gitattributes` LF rule and convert the file before committing.

## Sweep Trigger Policy

Manual, by default: run `bash tools/sweep.sh` between features or after a harness change. CI runs the quick principle check and full structural validation on pushes to `main` and pull requests; the full sweep remains manual to avoid a heavy session-start loop.

## Scratchpad Convention

Intermediate artifacts live in the session scratchpad directory (path given in the system prompt).
Naming: `{phase:02d}_{agent}_{artifact}.{ext}`

Ephemeral — gone at session end, no cross-session resume.

Separate mechanism: delegation-gate evidence files live in `.claude/tmp/` (gitignored, session_id-stamped — see `references/enforcement-template.md`).

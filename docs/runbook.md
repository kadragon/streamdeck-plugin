# Runbook

## Quick Start

### Prerequisites

- Node.js 24 for the Stream Deck package (`node --version`)
- npm (`npm --version`)
- Stream Deck CLI available as `streamdeck` for linking/validation
- Bash and `jq` for the Claude status-line wrapper and harness scripts
- Windows 10 or later for the System Monitor action
- NVIDIA driver with `nvidia-smi.exe` available on PATH for GPU readings

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

### System Monitor

The **System Monitor** action is Windows-only. Choose CPU or GPU in its Property Inspector; the key shows
only the selected utilization percentage, while the background color represents that metric's temperature.
CPU utilization and high-precision thermal-zone temperature come from PowerShell `Get-Counter`; NVIDIA
GPU utilization and temperature come from the first row of:

```text
nvidia-smi.exe --query-gpu=utilization.gpu,temperature.gpu --format=csv,noheader,nounits
```

The key refreshes immediately when it appears, every five seconds while visible, and again after
system wake. If PowerShell counters, `nvidia-smi.exe`, or an individual reading is unavailable or
invalid, that field shows `--` rather than zero. The key background is green below 60 C, amber from
60 through 79.9 C, and red at 80 C or higher.

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
- `npm run check:package` exits 0 after the build and confirms the generated package entry point and metadata.
- `streamdeck link` installs the package; press a configured key after the corresponding source has produced local data.

## Build and Check

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript check without emitting |
| `npm run build` | Rollup production bundle |
| `npm run check:principles` | Golden-principle structural checks with agent-readable fixes |
| `npm run check:package` | Manifest and generated Stream Deck package-output checks |
| `npm run check` | Typecheck, principle checks, and build |
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

Manual, by default: run `bash tools/sweep.sh` between features or after a harness change. CI runs `npm run check` and the generated package-output check on pushes to `main` and pull requests; harness validation and the full sweep remain manual maintenance operations.

## Scratchpad Convention

Intermediate artifacts live in the session scratchpad directory (path given in the system prompt).
Naming: `{phase:02d}_{agent}_{artifact}.{ext}`

Ephemeral — gone at session end, no cross-session resume.

Separate mechanism: delegation-gate evidence files live in `.claude/tmp/` (gitignored, session_id-stamped — see `references/enforcement-template.md`).

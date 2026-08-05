# Stream Deck plugin

A personal Stream Deck plugin bundling the keys I use while working with terminal AI agents. Everything
is read from files the tools write locally; the plugin never calls an API.

| Action | What the key does |
| --- | --- |
| **Weekly Limit** | Shows how much of the weekly rate-limit allowance Claude Code or Codex CLI has consumed |
| **Agent Attention** | Blinks when a wrapped agent session needs you, and focuses its Warp tab when pressed |
| **Warp Tab Config** | Opens one of Warp's saved Tab Configs |

## Weekly Limit — where the numbers come from

| Source | Origin | Freshness |
| --- | --- | --- |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` → last `token_count` event's `rate_limits` window whose `window_minutes` is closest to 10080 (7 days) | As of the last Codex turn |
| Claude Code | `~/.claude/ai-usage/claude.json` (+ `claude-history.jsonl`), written by `scripts/statusline-usage-snapshot.sh` | As of the last status-line render |

Claude Code does not persist rate-limit percentages anywhere. It pushes them to the status line on
stdin and nowhere else, so `scripts/statusline-usage-snapshot.sh` wraps the status line: it tees the
payload into a JSON snapshot and then forwards it untouched to the real status line command
(claude-hud). Without that wrapper the Claude key shows `no data`.

A reading older than six hours is marked stale — amber dot, amber caption, dimmed number — because it
means the tool itself has not run recently, not that usage is at zero. The caption wording keeps the
two durations apart: `in 3d 12h` counts down to the weekly reset, `4d 14h ago` is the age of the
reading. Past the alert threshold the number turns red while the label keeps the source's brand colour.

## Burn rate

When the recent rate of consumption would exhaust the allowance *before* the window resets, the caption
switches to that estimate in red — `out in 4h 20m` — because that is the case worth acting on. Otherwise
it stays on the reset countdown.

The estimate uses only samples since the last reset: a percentage that drops means the window rolled
over, and averaging across that boundary would understate the current rate. It is withheld unless the
samples span at least 10 minutes and rise by at least 0.5 points, so a flat or very short series
produces no projection rather than a wild one.

Codex needs no extra plumbing — a rollout records `rate_limits` on every turn, so the series is already
there. Claude Code has only the transient status-line payload, so the wrapper appends one line to
`claude-history.jsonl` per *change* in the percentage (the status line renders far more often than the
number moves), trimming the file at 500 lines.

## Setup

```bash
npm install
npm run build
streamdeck link com.kadragon.aiusage.sdPlugin
```

Then point Claude Code's status line at the wrapper in `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bash /c/dev/stream-deck-plugin/scripts/statusline-usage-snapshot.sh"
}
```

The wrapper currently hard-codes claude-hud as the downstream status line; edit its last line if you
use a different one.

## Development

```bash
npm run watch   # rebuilds and restarts the plugin in Stream Deck
```

`streamdeck validate` needs network access to Elgato's servers and will fail behind a blocking proxy;
it is not required to run the plugin locally.

## Key configuration

Each key's Property Inspector exposes:

- **Source** — Claude Code or Codex CLI
- **Refresh** — how often the local files are re-read (15–600s, default 60s)
- **Alert at** — percentage at which the number turns red (50–100%, default 90%)
- **Usage page** — the URL a press opens; blank falls back to the default for the source

Pressing a key opens the usage page in the default browser. Keys refresh on their own interval, so a
press does not re-read. Defaults:

| Source | Usage page |
| --- | --- |
| Claude Code | `https://claude.ai/settings/usage` |
| Codex CLI | `https://chatgpt.com/?openaicom_referred=true#settings/Usage` |

Keys also refresh automatically when the machine wakes from sleep (`onSystemDidWakeUp`), since nothing
is read while it is asleep.

## Agent attention for Warp

The **Agent Attention** action blinks when a wrapped Claude Code or Codex CLI session finishes a turn or
waits for input, then focuses a configured Warp tab when pressed. Choose the source that matches the
wrapped process; v1 does not auto-detect it. This first version uses fixed tab positions 1-8 in one
Warp window; it does not discover or track tabs after they are reordered.

### Start an agent through the wrapper

Use the same tab number configured on the Stream Deck key. Keep the command after `--` so all of its
arguments pass through unchanged:

```powershell
node C:/dev/stream-deck-plugin/scripts/agent-wrap.mjs --source claude --tab 3 -- claude
node C:/dev/stream-deck-plugin/scripts/agent-wrap.mjs --source codex --tab 4 -- codex
```

The wrapper inherits the interactive terminal's stdio and publishes only local lifecycle metadata. It
sets `AGENT_ATTENTION_RUNTIME_ID`, `AGENT_ATTENTION_TAB`, and `AGENT_ATTENTION_STATE_DIR` for the child
so its hooks can associate events with the configured slot.

### Configure hooks

Merge the matching example into the tool's existing configuration; replace the placeholder script path:

- Claude Code: `scripts/claude-agent-hooks.example.json` into `~/.claude/settings.json`
- Codex CLI: `scripts/codex-agent-hooks.example.json` into `~/.codex/hooks.json` (or the active hooks config)

The hook command must use the same `node` installation visible to the wrapped agent. Codex may ask you
to review and trust the hook definitions before running them. Hooks without the wrapper's tab environment
are intentionally ignored, so an unwrapped session cannot be assigned to the wrong key.

Set `AGENT_ATTENTION_STATE_DIR` explicitly when the agent runs in WSL or another environment whose home
directory differs from the Stream Deck process. The directory is local and contains short JSON event files;
assistant messages and terminal output are never written there.

## Launch a Warp Tab Config

The **Warp Tab Config** action opens one of Warp's saved `.toml` Tab Configs from a Stream Deck key.
Choose the config in the action's Property Inspector; the list is read from Warp's local
`tab_configs` directory and can be refreshed after config files change. The key opens the selected config
through Warp's `warp://tab_config/<filename>` URI scheme, so the configured directory, shell, panes, and
startup commands remain owned by Warp.

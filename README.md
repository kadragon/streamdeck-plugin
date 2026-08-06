# Stream Deck plugin

A personal Stream Deck plugin bundling the keys I use while working with terminal AI agents. Everything
is read from local files or native local commands; the plugin never calls an API.

| Action | What the key does |
| --- | --- |
| **Weekly Limit** | Shows how much of the weekly rate-limit allowance Claude Code or Codex CLI has consumed |
| **AI Usage Overview** | Shows Claude Code and Codex CLI usage together, with used, remaining, burn-rate, and reset views |
| **System Monitor** | Shows local Windows CPU, RAM, disk, network, NVIDIA GPU, memory, and power metrics |
| **Warp Tab Config** | Opens one of Warp's saved Tab Configs |
| **Warp URI** | Opens a validated Warp or Warp Preview URI |

## System Monitor (Windows)

The **System Monitor** action is Windows-only and hidden on macOS. Choose CPU, GPU, RAM, disk, network,
GPU memory, or GPU power in the action's Property Inspector. GPU metrics use the selected NVIDIA GPU
index. CPU and GPU temperatures tint the background; unavailable readings show `--` rather than zero.
It reads CPU utilization and thermal-zone data through PowerShell `Get-Counter`, and reads local RAM,
disk, and network values without an API. NVIDIA metrics come from:

```text
nvidia-smi.exe --query-gpu=index,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits
```

The NVIDIA driver must provide `nvidia-smi.exe` on PATH. The key refreshes every five seconds and
refreshes again after system wake. Missing counters, an unavailable `nvidia-smi.exe`, and invalid
readings show `--`; they are never displayed as zero. Available temperatures tint the background green
below 60 C, amber from 60 through 79.9 C, and red at 80 C or higher.

## AI Usage Overview

The **AI Usage Overview** action shows Claude Code and Codex CLI on one key. Its view can be set to
used percentage, remaining percentage, recent burn rate, or reset countdown. Press the key, or push
the dial on Stream Deck+, to cycle between views. It uses the same local files as **Weekly Limit**.

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

## Launch a Warp Tab Config

The **Warp Tab Config** action opens one of Warp's saved `.toml` Tab Configs from a Stream Deck key.
Choose the config in the action's Property Inspector; the list is read from Warp's local
`tab_configs` directory and can be refreshed after config files change. The key opens the selected config
through Warp's `warp://tab_config/<filename>` URI scheme, so the configured directory, shell, panes, and
startup commands remain owned by Warp. Each key press opens the selected config as a new tab in the active
Warp window.

## Launch a Warp URI

The **Warp URI** action accepts `warp://` and `warppreview://` links such as
`warp://action/new_tab`, `warp://launch/<config>`, and `warp://settings`. All other URI schemes are
rejected before the native URI handler is called.

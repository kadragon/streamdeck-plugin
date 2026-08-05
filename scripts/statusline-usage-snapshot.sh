#!/bin/bash
# Claude Code status-line wrapper that snapshots rate-limit usage for the AI Usage Stream Deck plugin.
#
# Claude Code reports `rate_limits` only on the status line's stdin, never to disk. This script tees that
# payload into a JSON snapshot the plugin can poll, then hands the untouched payload to the real status
# line command so the existing status line keeps working.
#
# Two files are written:
#   claude.json          latest observation
#   claude-history.jsonl one line per *change* in the weekly percentage, for the burn-rate estimate
#
# Wire it up in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "bash /c/dev/stream-deck-plugin/scripts/statusline-usage-snapshot.sh" }

set -uo pipefail

SNAPSHOT_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ai-usage"
SNAPSHOT="$SNAPSHOT_DIR/claude.json"
HISTORY="$SNAPSHOT_DIR/claude-history.jsonl"

# The status line renders far more often than the percentage changes, so history is appended only on a
# change. Trimming keeps the file bounded without needing a separate cleanup step.
HISTORY_MAX_LINES=500
HISTORY_TRIM_TO=300

input=$(cat)

# Write the snapshot only when a percentage is actually present; Claude Code leaves rate_limits empty
# before the first model response of a session, and an empty write would erase a good reading.
if command -v jq >/dev/null 2>&1; then
  mkdir -p "$SNAPSHOT_DIR"
  observation=$(printf '%s' "$input" | jq -c '
    select(.rate_limits.seven_day.used_percentage != null or .rate_limits.five_hour.used_percentage != null)
    | { updated_at: (now | todateiso8601), five_hour: .rate_limits.five_hour, seven_day: .rate_limits.seven_day }
  ' 2>/dev/null)

  if [ -n "$observation" ]; then
    printf '%s\n' "$observation" > "$SNAPSHOT.tmp" && mv -f "$SNAPSHOT.tmp" "$SNAPSHOT"

    current=$(printf '%s' "$observation" | jq -r '.seven_day.used_percentage // empty')
    previous=$(tail -n 1 "$HISTORY" 2>/dev/null | jq -r '.seven_day.used_percentage // empty' 2>/dev/null)

    if [ -n "$current" ] && [ "$current" != "$previous" ]; then
      printf '%s\n' "$observation" >> "$HISTORY"

      lines=$(wc -l < "$HISTORY" 2>/dev/null || echo 0)
      if [ "$lines" -gt "$HISTORY_MAX_LINES" ]; then
        tail -n "$HISTORY_TRIM_TO" "$HISTORY" > "$HISTORY.tmp" && mv -f "$HISTORY.tmp" "$HISTORY"
      fi
    fi
  fi
fi

# Delegate to claude-hud, preserving the original terminal-width handling.
# The braces keep bash's own "no such device" message quiet when there is no controlling terminal.
cols=$({ stty size </dev/tty; } 2>/dev/null | awk '{print $2}')
export COLUMNS=$(( ${cols:-120} > 4 ? ${cols:-120} - 4 : 1 ))
plugin_dir=$(ls -1d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-hud/*/ 2>/dev/null | sort -V | tail -1)

printf '%s' "$input" | exec "/c/Program Files/nodejs/node" "${plugin_dir}dist/index.js"

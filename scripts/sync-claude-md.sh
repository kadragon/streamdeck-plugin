#!/usr/bin/env bash
# Repair CLAUDE.md to the canonical @AGENTS.md pointer.

set -euo pipefail

CLAUDE_MD=CLAUDE.md
if [[ $# -gt 0 ]]; then
  CLAUDE_MD="$1"
fi
if [[ ! -f "$CLAUDE_MD" ]]; then
  printf '%s\n' '@AGENTS.md' > "$CLAUDE_MD"
  exit 1
fi

if [[ "$(tr -d '[:space:]' < "$CLAUDE_MD")" == "@AGENTS.md" ]]; then
  exit 0
fi

cat "$CLAUDE_MD"
exit 2

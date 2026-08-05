#!/usr/bin/env bash
# Warn when the always-loaded instruction map exceeds the configured limit.

set -euo pipefail

LIMIT=200
if env | grep -q '^CONTEXT_SIZE_LIMIT='; then
  LIMIT="$CONTEXT_SIZE_LIMIT"
fi
effective=AGENTS.md
if [[ ! -f "$effective" && -f CLAUDE.md ]]; then
  effective=CLAUDE.md
fi
[[ -f "$effective" ]] || exit 0

lines=$(wc -l < "$effective" | tr -d ' ')
if [[ "$lines" -gt "$LIMIT" ]]; then
  printf 'context-size: %s is %s lines (>%s); move detail to docs/\n' "$effective" "$lines" "$LIMIT"
fi
exit 0

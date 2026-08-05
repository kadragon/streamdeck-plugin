#!/usr/bin/env bash
# Ensure .agents/skills resolves to ../.claude/skills.

set -euo pipefail

TARGET="../.claude/skills"
LINK=".agents/skills"

if [[ -L "$LINK" ]]; then
  [[ "$(readlink "$LINK")" == "$TARGET" ]] && exit 0
  echo "symlink-guard: wrong symlink target; fix manually: $LINK -> $TARGET" >&2
  exit 1
fi

if [[ -f "$LINK" ]]; then
  [[ "$(tr -d '\r\n' < "$LINK")" == "$TARGET" ]] && exit 0
  echo "symlink-guard: wrong text-pointer content; fix manually: $LINK" >&2
  exit 1
fi

if [[ -e "$LINK" ]]; then
  echo "symlink-guard: unexpected existing path at $LINK; no data removed" >&2
  exit 1
fi

mkdir -p .agents .claude/skills
if ln -s "$TARGET" "$LINK" 2>/dev/null && [[ -L "$LINK" ]]; then
  echo "Symlink created: $LINK -> $TARGET"
else
  printf '%s' "$TARGET" > "$LINK"
  echo "Text-pointer created: $LINK -> $TARGET"
fi

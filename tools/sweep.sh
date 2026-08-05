#!/usr/bin/env bash
# Manual harness garbage collection. Usage: bash tools/sweep.sh [--quick]

set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$TOOLS_DIR/.." && pwd)"
cd "$PROJ_DIR"

QUICK_MODE=false
if [[ $# -gt 0 && "$1" == "--quick" ]]; then
  QUICK_MODE=true
fi

FINDINGS=""
FINDING_COUNT=0
add_finding() {
  FINDINGS="$FINDINGS$1\n"
  FINDING_COUNT=$((FINDING_COUNT + 1))
}

echo "=== Sweep ==="
echo "Date: $(date '+%Y-%m-%d %H:%M')"

echo "[1/5] Principle and lint scan"
principle_output=""
if principle_output=$(npm run check:principles 2>&1); then
  echo "$principle_output"
else
  echo "$principle_output"
  add_finding "[constraint] npm run check:principles failed"
fi

if $QUICK_MODE; then
  if [[ $FINDING_COUNT -eq 0 ]]; then
    echo "Quick sweep clean."
    exit 0
  fi
  printf '%b' "$FINDINGS"
  exit 1
fi

echo "[2/5] Documentation drift"
recent_files=$(git log --since="24 hours ago" --name-only --pretty=format: 2>/dev/null | sort -u || true)
has_source=false
has_doc=false
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  [[ "$file" == src/* || "$file" == scripts/* || "$file" == com.kadragon.aiusage.sdPlugin/manifest.json ]] && has_source=true
  [[ "$file" == docs/* || "$file" == README.md ]] && has_doc=true
done <<< "$recent_files"
if $has_source && ! $has_doc; then
  add_finding "[doc] recent source or manifest commit has no README/docs update"
else
  echo "Recent source/documentation changes are paired or no recent source changes exist."
fi

echo "[3/5] Golden principle spot-check"
if [[ $FINDING_COUNT -eq 0 ]]; then
  echo "Principle checks passed above."
else
  echo "Principle findings already recorded."
fi

echo "[4/5] Harness freshness"
harness_output=""
harness_status=0
harness_output=$(bash scripts/validate-harness.sh 2>&1) || harness_status=$?
echo "$harness_output"
if [[ $harness_status -ne 0 ]]; then
  add_finding "[harness] structural validation failed"
fi

while IFS= read -r doc; do
  [[ -z "$doc" ]] && continue
  [[ -f "$doc" ]] || add_finding "[harness] AGENTS.md references missing file: $doc"
done < <(grep -oE 'docs/[A-Za-z0-9_./-]+\.md' AGENTS.md 2>/dev/null | sort -u || true)

for key_doc in docs/architecture.md docs/conventions.md docs/workflows.md docs/delegation.md docs/eval-criteria.md docs/runbook.md docs/harness-log.md; do
  [[ -f "$key_doc" ]] || add_finding "[harness] missing key doc: $key_doc"
done

echo "[5/5] Finding report"
if [[ $FINDING_COUNT -eq 0 ]]; then
  echo "=== Sweep clean ==="
  exit 0
fi

echo "=== $FINDING_COUNT finding(s) ==="
printf '%b' "$FINDINGS" | sed 's/^/  /'
if [[ -f tasks.md ]]; then
  {
    echo
    echo "## Sweep $(date '+%Y-%m-%d %H:%M')"
    printf '%b' "$FINDINGS" | sed 's/^/- [ ] /'
  } >> tasks.md
  echo "Findings appended to tasks.md."
else
  echo "No active tasks.md; review findings and add backlog items as needed."
fi
exit 1

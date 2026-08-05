#!/usr/bin/env bash
# Validate the repository harness. Usage: bash scripts/validate-harness.sh [repo-root]

set -euo pipefail

PROJ_DIR=.
if [[ $# -gt 0 ]]; then
  PROJ_DIR="$1"
fi
cd "$PROJ_DIR"

PASS=0
WARN=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
warn() { WARN=$((WARN + 1)); printf '  WARN  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

echo "=== Harness Validation ==="
echo "  Project: $(pwd)"
echo

echo "--- Required Files ---"
for file in AGENTS.md CLAUDE.md backlog.md \
  docs/architecture.md docs/conventions.md docs/workflows.md \
  docs/delegation.md docs/eval-criteria.md docs/runbook.md docs/harness-log.md \
  scripts/check-principles.mjs tools/sweep.sh .github/workflows/quality.yml; do
  if [[ -f "$file" ]]; then
    pass "$file exists"
  else
    fail "$file missing"
  fi
done

echo
echo "--- Executable Text Line Endings ---"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  crlf=0
  while IFS= read -r file; do
    [[ -z "$file" || ! -f "$file" ]] && continue
    if LC_ALL=C grep -q $'\r' "$file"; then
      warn "$file contains CR characters; keep executable scripts LF-normalized"
      crlf=1
    fi
  done < <(git ls-files '*.sh' '*.bash' '*.py' 2>/dev/null || true)
  [[ $crlf -eq 0 ]] && pass "tracked shell/Python scripts use LF line endings"
else
  warn "outside a git worktree; skipped line-ending check"
fi

echo
echo "--- AGENTS.md Size and Sections ---"
if [[ -f AGENTS.md ]]; then
  lines=$(wc -l < AGENTS.md | tr -d ' ')
  if [[ $lines -le 100 ]]; then
    pass "AGENTS.md is $lines lines (target <=100)"
  elif [[ $lines -le 200 ]]; then
    warn "AGENTS.md is $lines lines (target <=100)"
  else
    fail "AGENTS.md is $lines lines (hard limit 200)"
  fi

  for section in "Docs Index" "Golden Principles" "Delegation" "Token Economy" \
    "Working with Existing Code" "Language Policy" "Maintenance"; do
    if grep -q "^## $section" AGENTS.md; then
      pass "AGENTS.md has ## $section"
    else
      fail "AGENTS.md missing ## $section"
    fi
  done

  principle_count=$(awk '
    /^## Golden Principles/ { inside=1; next }
    /^## / { inside=0 }
    inside && /^[0-9]+\./ { count++ }
    END { print count + 0 }
  ' AGENTS.md)
  if [[ $principle_count -ge 3 && $principle_count -le 7 ]]; then
    pass "$principle_count golden principles defined"
  else
    fail "AGENTS.md has $principle_count golden principles; expected 3-7"
  fi

  while IFS= read -r doc; do
    [[ -z "$doc" ]] && continue
    if [[ -f "$doc" ]]; then
      pass "referenced $doc exists"
    else
      fail "referenced $doc missing"
    fi
  done < <(grep -oE 'docs/[A-Za-z0-9_./-]+\.md' AGENTS.md | sort -u)
else
  fail "cannot inspect missing AGENTS.md"
fi

echo
echo "--- Pointer and State Invariants ---"
if [[ -f CLAUDE.md ]] && [[ "$(tr -d '[:space:]' < CLAUDE.md)" == "@AGENTS.md" ]]; then
  pass "CLAUDE.md is exactly @AGENTS.md"
else
  fail "CLAUDE.md is not a pure @AGENTS.md pointer"
fi

if [[ -L .agents/skills ]]; then
  [[ "$(readlink .agents/skills)" == "../.claude/skills" ]] \
    && pass ".agents/skills points to ../.claude/skills" \
    || fail ".agents/skills has the wrong symlink target"
elif [[ -f .agents/skills ]]; then
  [[ "$(tr -d '\r\n' < .agents/skills)" == "../.claude/skills" ]] \
    && pass ".agents/skills has the Windows text-pointer form" \
    || fail ".agents/skills has the wrong text-pointer content"
else
  fail ".agents/skills is missing"
fi

backlog_heading=false
backlog_item=false
if [[ -f backlog.md ]]; then
  grep -q '^## ' backlog.md && backlog_heading=true
  grep -Eq '^[[:space:]]*-[[:space:]]+\[[ x>]\]' backlog.md && backlog_item=true
  $backlog_heading && pass "backlog.md has a ## heading" || fail "backlog.md has no ## heading"
  $backlog_item && pass "backlog.md has standard checkbox items" || warn "backlog.md is empty (allowed at init)"
else
  fail "backlog.md is missing"
fi

echo
echo "--- Enforcement and Role Shape ---"
if [[ -d .github/workflows ]]; then
  pass "CI workflow directory exists"
else
  fail "CI workflow directory missing"
fi

for role in .claude/agents/*.md; do
  [[ -e "$role" ]] || continue
  missing=""
  grep -q '^name:' "$role" || missing="$missing name"
  grep -q '^description:' "$role" || missing="$missing description"
  for section in "Objective" "Spawn Prompt Contract" "Effort Tier" "Exit Criteria"; do
    grep -q "^## $section" "$role" || missing="$missing $section"
  done
  if [[ -z "$missing" ]]; then
    pass "$role has required role sections"
  else
    fail "$role missing:$missing"
  fi
done

if grep -q 'ALWAYS invoke' .claude/skills/code-orchestrator/SKILL.md &&
   grep -q 'Do NOT inline-execute' .claude/skills/code-orchestrator/SKILL.md; then
  pass "code-orchestrator has a directive description"
else
  fail "code-orchestrator description is not directive"
fi

echo
echo "--- Maturity ---"
level1=true
for file in AGENTS.md CLAUDE.md backlog.md docs/architecture.md docs/runbook.md; do
  [[ -f "$file" ]] || level1=false
done
[[ "$(tr -d '[:space:]' < CLAUDE.md 2>/dev/null || true)" == "@AGENTS.md" ]] || level1=false

level2=false
if $level1 && [[ -d .github/workflows ]] && [[ -f docs/delegation.md ]]; then
  level2=true
fi

if $level2; then
  echo "  LEVEL 2 - Verified (CI + structural checks active)"
elif $level1; then
  echo "  LEVEL 1 - Basic (docs present; CI incomplete)"
else
  echo "  LEVEL 0 - Not initialized"
fi

echo
echo "=== Summary ==="
printf '  PASS: %s  WARN: %s  FAIL: %s\n' "$PASS" "$WARN" "$FAIL"
if [[ $FAIL -gt 0 ]]; then
  echo "Harness incomplete; fix FAIL items before proceeding."
  exit 1
fi
if [[ $WARN -gt 0 ]]; then
  echo "Harness functional with warnings."
else
  echo "Harness complete."
fi

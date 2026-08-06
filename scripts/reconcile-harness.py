#!/usr/bin/env python3
"""Reconcile an active tasks.md Sprint Contract with backlog.md."""

from __future__ import annotations

import re
from pathlib import Path

TASKS = Path("tasks.md")
BACKLOG = Path("backlog.md")


def field(content: str, name: str) -> str | None:
    match = re.search(r"^" + re.escape(name) + r":\s*(.+)$", content, re.MULTILINE | re.IGNORECASE)
    return match.group(1).strip() if match else None


def title(content: str) -> str:
    match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    return match.group(1).strip() if match else "untitled sprint"


def anchors(content: str) -> list[str]:
    covers = re.search(r"^## Covers\s*\n((?:\s*-\s*.+\n?)+)", content, re.MULTILINE)
    if covers:
        values = [line.strip()[1:].strip() for line in covers.group(1).splitlines() if line.strip().startswith("-")]
        if values:
            return values
    return [title(content)]


def update_backlog(content: str, sprint_anchors: list[str], status: str, note: str = "") -> str:
    result: list[str] = []
    for line in content.splitlines(keepends=True):
        active = re.match(r"^\s*-\s*\[>\]\s*(.*)", line)
        matches = active and any(anchor.lower() in active.group(1).lower() for anchor in sprint_anchors)
        if matches and status == "done":
            continue
        if matches and status == "failed":
            line = line.replace("[>]", "[ ]", 1).rstrip("\n") + "  <!-- " + note[:80] + " -->\n"
        result.append(line)
    return "".join(result)


def remove_orphans(content: str) -> str:
    return re.sub(r"^\s*-\s*\[>\].*\n?", "", content, flags=re.MULTILINE)


def main() -> None:
    if not TASKS.exists():
        if BACKLOG.exists():
            original = BACKLOG.read_text(encoding="utf-8")
            cleaned = remove_orphans(original)
            if cleaned != original:
                BACKLOG.write_text(cleaned, encoding="utf-8")
        print("Backlog idle.")
        return

    content = TASKS.read_text(encoding="utf-8")
    status = field(content, "status")
    if status is None:
        raise SystemExit("tasks.md is missing status: active|evaluating|done|failed")
    status = status.lower()
    if status in {"active", "evaluating"}:
        print("Sprint active: " + title(content))
        return
    if status not in {"done", "failed"}:
        raise SystemExit("tasks.md has unknown status: " + status)

    backlog = BACKLOG.read_text(encoding="utf-8") if BACKLOG.exists() else ""
    note = field(content, "Evaluator Feedback") or "failed"
    BACKLOG.write_text(update_backlog(backlog, anchors(content), status, note), encoding="utf-8")
    TASKS.unlink()
    print("Sprint " + status + ": " + title(content))


if __name__ == "__main__":
    main()

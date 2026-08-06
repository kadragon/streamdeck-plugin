# Backlog

## Review Backlog

### PR #5 — Dial layout slots and CPU package temperature (2026-08-06)

- [ ] [debt] Apply `setFeedbackLayout` once per action instead of on every refresh; with a custom layout each call may reset every slot to its declared default and flash before `setFeedback` lands (source: review, confidence 45 — unverified against Stream Deck 6.x caching behavior) — src/actions/usage-overview.ts:154

# Tasks

## Review Backlog

### harness/init-stream-deck — agent attention and Warp tab config actions (2026-08-05)

- [ ] [debt] Prune stale spool files from the writer side so the events directory stays bounded when the Stream Deck plugin never runs; the reader now drops events older than the TTL but only while it is polling (source: review) — `src/agent-attention/spool.ts:89`, `scripts/agent-event.mjs:44`

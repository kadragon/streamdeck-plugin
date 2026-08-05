# Tasks

## Review Backlog

### fix/prune-stale-spool-files — writer-side spool pruning (2026-08-05)

- [ ] [debt] `src/agent-attention/spool.ts` has no importer in `src/`, so its `writeAgentEvent`/`pruneStaleEvents` pair ships untested while the smoke test covers only the `scripts/agent-event.mjs` copy; decide whether the TS writer is a real API or should be dropped, and cover whichever survives (source: review) — `src/agent-attention/spool.ts:64`

# 00 — Coordinator

> Use this only when coordinating the whole Drift v2: Action Chains spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 Chain State and Schema
  └─ 02 Chain Detection and Scoring
       └─ 03 Orchestrator Integration
            └─ 04 Event and Summary
```

Recommended sequential order:

1. `01-chain-state-and-schema.md` — schema + state container (no orchestrator changes)
2. `02-chain-detection-and-scoring.md` — pure scoring function (depends on types from 01)
3. `03-orchestrator-integration.md` — wire into task-step.ts (depends on 01 + 02)
4. `04-event-and-summary.md` — event variant + summary extension (depends on 01 + 03)

Briefs 03 and 04 both touch `src/engine/events/types.ts` and `src/core/paths.ts`. If running in parallel, coordinate to avoid merge conflicts on those files. Sequential execution is preferred.

## Shared Files To Read

- `CLAUDE.md`
- `docs/ARCHITECTURE.md`
- `docs/CONCEPTS.md`
- `docs/WORKFLOW.md`
- `docs/TESTING.md`
- `src/core/paths.ts`
- `src/core/schemas/task.ts`
- `src/core/schemas/summary.ts`
- `src/engine/events/types.ts`
- `src/engine/orchestrator/drift.ts`
- `src/engine/orchestrator/drift.test.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/summary.ts`
- `src/lib/fs.ts`

Do **not** modify `drift.ts` or `drift.test.ts`.

## Shared Invariants

- Do not stage or commit.
- No new runtime dependencies.
- No classes.
- No barrels (no re-export-only `index.ts`).
- Use ESM `.js` import suffixes everywhere.
- Engine code must not import from `ink`, `react`, `src/features/`, or `src/components/`.
- Tests assert behavior, returned state, persisted artifacts, or published events. Do not assert private helper calls.
- Chain analysis failure in the task loop must be caught and published as a `warning` event; it must never abort a task.
- `src/engine/orchestrator/drift.ts` and `src/engine/orchestrator/drift.test.ts` are read-only for all briefs.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

For final handoff:

```bash
npm run test-ci
```

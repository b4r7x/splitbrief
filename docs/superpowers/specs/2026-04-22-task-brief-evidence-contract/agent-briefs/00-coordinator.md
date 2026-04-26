# 00 — Coordinator

> Use this only when coordinating the whole Task Brief v1 + Evidence Contract spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 Task Brief Quality Gate
  ├─ 02 Evidence Ledger
  │    └─ 03 Brief/Code Drift Detector
  └─ 04 Test Policy Cleanup
```

Recommended order:

1. `01-task-brief-quality-gate.md`
2. `02-evidence-ledger.md`
3. `03-brief-drift-detector.md`
4. `04-test-policy-cleanup.md`

`04-test-policy-cleanup.md` can run independently if no agent is editing the same test files.

## Shared Files To Read

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `docs/CONCEPTS.md`
- `docs/WORKFLOW.md`
- `docs/TESTING.md`
- `docs/HOOKS.md`
- `src/core/schemas/task.ts`
- `src/engine/spec/parser.ts`
- `src/engine/spec/formatter.ts`
- `src/engine/orchestrator/final-review.ts`
- `src/engine/orchestrator/summary.ts`

## Shared Invariants

- Do not stage or commit.
- No new runtime dependencies.
- No classes.
- No barrels.
- Use ESM `.js` import suffixes.
- Engine code must not import React/Ink/UI modules.
- Tests assert behavior, persisted artifacts, returned state, or rendered output.
- Do not assert private helper calls.

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

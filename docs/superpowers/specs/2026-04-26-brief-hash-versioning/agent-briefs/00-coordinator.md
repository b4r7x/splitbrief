# 00 — Coordinator

> Use this only when coordinating the whole Brief Hash Versioning spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 Canonical JSON and Hash          (pure utilities, no existing-code dependencies)
  └─ 03 Task Schema and Tests       (extends EvidenceLedger/EvidenceTask schemas)
       └─ 02 Evidence and Drift Integration   (wires briefHash at runtime)
```

**CRITICAL:** The numeric order of briefs (01, 02, 03) does NOT match the implementation order. Implement in this sequence:

1. `01-canonical-json-and-hash.md`
2. `03-task-schema-and-tests.md`
3. `02-evidence-and-drift-integration.md`

Brief 02 calls `hashTaskBrief` (from 01) and reads `briefHash` fields from schema types (from 03). Both must compile before 02 can typecheck. If running briefs as parallel agents, 02 must be blocked until 01 and 03 complete.

## Why the Inversion

Brief 03 touches `src/core/schemas/evidence.ts` to add `briefHash` fields. Brief 02 touches `src/engine/orchestrator/evidence.ts` and `src/engine/orchestrator/drift.ts`, which import from `src/core/schemas/evidence.ts`. TypeScript will reject brief 02's changes if the schema does not already include `briefHash`.

## Shared Files To Read

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `docs/LAYERS.md`
- `src/core/schemas/task.ts`
- `src/core/schemas/evidence.ts`
- `src/engine/orchestrator/evidence.ts`
- `src/engine/orchestrator/drift.ts`
- `testing/helpers/factories/task.ts`

## Shared Invariants

- Do not stage or commit.
- No new npm runtime dependencies. Use `node:crypto` for sha256.
- No classes.
- No barrel `index.ts` files.
- Use ESM `.js` import suffixes in every import statement.
- Engine code must not import React/Ink/UI modules.
- Tests assert behavior, persisted shapes, and returned values. Do not assert private helper calls.
- `briefHash` is always present in new artifacts (written as `null` when unavailable, never omitted).
- Old sessions without the field must load without crashing.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

After all three briefs:

```bash
npm run test-ci
```

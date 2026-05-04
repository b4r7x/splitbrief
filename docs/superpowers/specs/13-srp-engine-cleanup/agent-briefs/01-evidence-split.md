# 01 — Split evidence.ts into evidence/ folder

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Split `src/engine/orchestrator/evidence/evidence.ts` (405 LOC, 12 exports, 4+ concerns) into focused modules inside the existing `evidence/` folder. Also fix the defensive `clone()` on every mutation — replace with structural sharing.

## Required Skills

- `/clean-code`
- `/code-audit`
- `/test-behavior-not-implementation`

## Required Reading

- `CLAUDE.md`
- `docs/STRUCTURE.md` — §Deep modules and folder colocation
- `docs/LAYERS.md`
- `src/engine/orchestrator/evidence/evidence.ts` — full file
- `src/engine/orchestrator/evidence/evidence.test.ts` — existing tests (if any)
- `src/engine/orchestrator/evidence/persistence.ts` — check if already exists
- `src/engine/orchestrator/evidence/review-packet/` — how evidence is consumed

## Write Ownership

```
src/engine/orchestrator/evidence/evidence.ts           (rewrite — becomes entry + orchestration)
src/engine/orchestrator/evidence/task-evidence.ts      (create — task-level recording)
src/engine/orchestrator/evidence/ledger.ts             (create — init, clone, findOrSeed, helpers)
src/engine/orchestrator/evidence/reporting.ts          (create — buildRejectionContext, buildEvidenceSummary)
src/engine/orchestrator/evidence/persistence.ts        (modify or create — read/write/path)
src/engine/orchestrator/evidence/evidence.test.ts      (modify — split test imports)
```

## Required Behavior

### Part A: Create ledger.ts — lifecycle and helpers

Move these functions from `evidence.ts` to `evidence/ledger.ts`:
- `createEvidenceLedger()` — and its `CreateEvidenceLedgerInput` type
- `emptyEvidenceTask()` (internal helper)
- `findOrSeed()` (internal helper)
- `recomputeValidationSummary()` (internal helper)
- `replaceTask()` (internal helper)
- `buildExpectedEvidence()` (internal helper, if it exists)

**Fix clone()**: Replace the current deep-clone-on-every-mutation with a targeted copy approach. Instead of cloning the entire ledger:

```typescript
// OLD (evidence.ts):
function clone(ledger: EvidenceLedger): EvidenceLedger {
  return {
    ...ledger,
    tasks: ledger.tasks.map(t => ({ ...t, validations: [...t.validations], ... })),
    approvals: [...ledger.approvals],
    rejections: [...ledger.rejections],
  };
}

// NEW (ledger.ts) — only clone the subtree that changes:
export function withUpdatedTask(
  ledger: EvidenceLedger,
  taskId: string,
  updater: (task: EvidenceTask) => EvidenceTask,
): EvidenceLedger {
  const tasks = ledger.tasks.map(t =>
    t.taskId === taskId ? updater({ ...t }) : t,
  );
  return { ...ledger, tasks, validationSummary: recomputeValidationSummary(tasks) };
}

export function withAppendedApproval(
  ledger: EvidenceLedger,
  entry: ApprovalEntry,
): EvidenceLedger {
  return { ...ledger, approvals: [...ledger.approvals, entry] };
}

export function withAppendedRejection(
  ledger: EvidenceLedger,
  entry: RejectionEntry,
): EvidenceLedger {
  return { ...ledger, rejections: [...ledger.rejections, entry] };
}
```

The `record*` functions in task-evidence.ts and evidence.ts then use `withUpdatedTask()` instead of `clone()` + mutation.

### Part B: Create task-evidence.ts — task-level recording

Move these functions from `evidence.ts` to `evidence/task-evidence.ts`:
- `recordLocalTaskEvidence()` + its input type
- `recordRetryOrEscalationEvidence()` + its input type
- `recordSkippedTaskEvidence()` + its input type
- `validationEntries()` (internal helper)

These import `findOrSeed`, `withUpdatedTask` from `./ledger.js`.

### Part C: Create reporting.ts — evidence summary builders

Move from `evidence.ts` to `evidence/reporting.ts`:
- `buildRejectionContext()`
- `buildEvidenceSummary()`

These are pure functions reading the ledger. No mutations.

### Part D: Ensure persistence.ts handles I/O

If `persistence.ts` already exists in the `evidence/` folder, verify it contains `writeEvidenceLedger`, `readEvidenceLedger`, `evidenceLedgerPath`. If not, move these from `evidence.ts` to `persistence.ts`.

### Part E: Rewrite evidence.ts as re-orchestration entry

`evidence.ts` becomes the entry point of the `evidence/` folder. It re-exports everything consumers need:

```typescript
// evidence.ts — entry point for the evidence/ folder
export { createEvidenceLedger } from './ledger.js';
export type { CreateEvidenceLedgerInput } from './ledger.js';

export { recordLocalTaskEvidence, recordRetryOrEscalationEvidence, recordSkippedTaskEvidence } from './task-evidence.js';
export type { RecordLocalTaskEvidenceInput, RecordRetryOrEscalationEvidenceInput, RecordSkippedTaskEvidenceInput } from './task-evidence.js';

export { recordFinalReviewEvidence, recordApprovalEvidence, recordRejectionEvidence } from './approval-evidence.js';
export type { RecordFinalReviewEvidenceInput, RecordApprovalEvidenceInput, RecordRejectionEvidenceInput } from './approval-evidence.js';

export { buildRejectionContext, buildEvidenceSummary } from './reporting.js';
export { writeEvidenceLedger, readEvidenceLedger, evidenceLedgerPath } from './persistence.js';
```

**WAIT — the project has a zero-barrels rule.** Do NOT create a re-export file. Instead, update each import site to import from the specific sub-module:

- Consumers importing `recordLocalTaskEvidence` → now import from `../evidence/task-evidence.js`
- Consumers importing `writeEvidenceLedger` → now import from `../evidence/persistence.js`
- Consumers importing `buildEvidenceSummary` → now import from `../evidence/reporting.js`
- Consumers importing `createEvidenceLedger` → now import from `../evidence/ledger.js`

Search for all import sites: `grep -rn "from.*evidence/evidence" src/ --include='*.ts'` and update each one.

### Part F: Move approval-level recording

Create `evidence/approval-evidence.ts` for:
- `recordFinalReviewEvidence()` + input type
- `recordApprovalEvidence()` + input type
- `recordRejectionEvidence()` + input type

These use `withAppendedApproval`, `withAppendedRejection` from `./ledger.js`.

### Part G: Delete the original evidence.ts

After all functions are moved and imports updated, delete `evidence.ts`. The folder now contains:
```
evidence/
├── ledger.ts               (lifecycle, structural sharing helpers)
├── task-evidence.ts         (task-level recording)
├── approval-evidence.ts     (approval/rejection/review recording)
├── reporting.ts             (summary builders)
├── persistence.ts           (I/O)
├── review-packet/           (existing — unchanged)
└── *.test.ts files          (colocated per new module)
```

## Tests

Split existing `evidence.test.ts` tests to match the new file structure. Each new module gets its own colocated `.test.ts`:
- `ledger.test.ts` — tests `createEvidenceLedger`, `withUpdatedTask`, `withAppendedApproval`
- `task-evidence.test.ts` — tests `recordLocalTaskEvidence`, `recordRetryOrEscalationEvidence`
- `reporting.test.ts` — tests `buildRejectionContext`, `buildEvidenceSummary`

Keep the same test assertions — just move them to the right file and update imports.

## Verification

- [ ] No file in `evidence/` exceeds 150 LOC
- [ ] Zero `clone()` calls — structural sharing via `withUpdatedTask` etc.
- [ ] All import sites updated (`grep -rn "evidence/evidence" src/` returns nothing)
- [ ] `evidence.ts` no longer exists (or is empty placeholder — prefer deletion)
- [ ] `npm run test-ci` passes

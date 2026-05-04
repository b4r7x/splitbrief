# 04 — Split escalation/step.ts within escalation/ folder

> Implement only this brief. Do not run git add/commit/stage/stash.
> **Depends on**: brief 01 (evidence split) and brief 03 (approval split). Execute after both.

## Goal

Split `src/engine/orchestrator/escalation/step.ts` (445 LOC, 2 exports, 4 concerns) into focused siblings inside the existing `escalation/` folder. Also deduplicate evidence persistence and conflict handling that were duplicated between step.ts and other files.

## Required Skills

- `/clean-code`
- `/code-audit`
- `/test-behavior-not-implementation`

## Required Reading

- `CLAUDE.md`
- `docs/STRUCTURE.md` — §Deep modules and folder colocation
- `src/engine/orchestrator/escalation/step.ts` — full file
- `src/engine/orchestrator/escalation/tier1-hint.ts` — existing sibling
- `src/engine/orchestrator/escalation/tier2-full.ts` — existing sibling
- `src/engine/orchestrator/approval/file-snapshots.js` — created in brief 03
- `src/engine/orchestrator/approval/staged-project.js` — created in brief 03
- `src/engine/orchestrator/evidence/task-evidence.js` — created in brief 01

## Write Ownership

```
src/engine/orchestrator/escalation/step.ts               (rewrite — keeps runRetryStep only)
src/engine/orchestrator/escalation/retry-runtime.ts      (create)
src/engine/orchestrator/escalation/retry-evidence.ts     (create)
src/engine/orchestrator/escalation/approval-conflict.ts  (create)
src/engine/orchestrator/escalation/validate-and-commit.ts (create)
```

## Required Behavior

### Part A: Create retry-runtime.ts

Move retry profile management:
- `retryConfigForProfile()` — updates config for profile override
- `stateForRetryProfile()` — mutates state to reflect new profile
- `createRetryRuntime()` — resolves profile and creates implementer
- Types: `RetryInvokeArgs` (if used only here)

~50 LOC.

### Part B: Create retry-evidence.ts

Move evidence persistence helpers:
- `persistRetryApprovalEvidence()` — records confirmation to ledger
- `persistRetryRejectionEvidence()` — records denial to ledger

These now import from the new evidence sub-modules (brief 01):
- `readEvidenceLedger` from `../evidence/persistence.js`
- `recordApprovalEvidence` from `../evidence/approval-evidence.js`
- `writeEvidenceLedger` from `../evidence/persistence.js`

~60 LOC.

### Part C: Create approval-conflict.ts

Move conflict handling:
- `handleApprovalTimeUserEditConflict()` — creates conflict recovery issue

This function was duplicated between step.ts and task/step.ts. **Create a single implementation** here and have both files import it. Search for duplicates:
```bash
grep -rn "handleApprovalTimeUserEditConflict\|approval.*promotion.*conflict" src/ --include='*.ts' | grep -v test
```

~30 LOC.

### Part D: Create validate-and-commit.ts

Move the `validateAndCommit()` function — the core approval gate + validation + commit orchestration. This is the largest single function (~100 LOC). It imports from:
- File snapshots (from approval/)
- Validation runner
- Commit utilities
- Retry evidence helpers

~120 LOC.

### Part E: Rewrite step.ts as orchestration entry

`step.ts` retains only `runRetryStep()` — the main coordinator that calls the extracted helpers. It becomes the entry point for the folder's retry orchestration.

After extraction, step.ts should be ~120-150 LOC — just the coordination logic.

Exports:
- `runRetryStep()` + `RetryStepOutcome` type
- `validateAndCommit()` (via re-import from `./validate-and-commit.js` — or consumers import directly)

### Part F: Update import sites

Search: `grep -rn "from.*escalation/step" src/ --include='*.ts' | grep -v test`

Update consumers:
- `validateAndCommit` consumers → import from `../escalation/validate-and-commit.js`
- `runRetryStep` consumers → import stays from `../escalation/step.js`
- `handleApprovalTimeUserEditConflict` → import from `../escalation/approval-conflict.js` (both step.ts and task/step.ts)

Final structure:
```
escalation/
├── step.ts               (~130 LOC — runRetryStep orchestration)
├── validate-and-commit.ts (~120 LOC — approval gate + validation)
├── retry-runtime.ts       (~50 LOC — profile management)
├── retry-evidence.ts      (~60 LOC — evidence persistence)
├── approval-conflict.ts   (~30 LOC — conflict handler, deduplicated)
├── escalation.ts          (existing — unchanged)
├── local-retries.ts       (existing — unchanged)
├── tier0-intermediate.ts  (existing — unchanged)
├── tier1-hint.ts          (existing — unchanged)
├── tier2-full.ts          (existing — unchanged)
└── *.test.ts files
```

## Tests

Create colocated tests for new modules:
- `retry-runtime.test.ts` — test `createRetryRuntime` with mock profile resolution
- `retry-evidence.test.ts` — test persistence helpers with mock ledger I/O
- `approval-conflict.test.ts` — test conflict recovery issue creation

Move relevant tests from `step.test.ts` (if exists) to the new locations.

## Verification

- [ ] `step.ts` is ≤150 LOC
- [ ] `handleApprovalTimeUserEditConflict` exists in exactly ONE file (approval-conflict.ts)
- [ ] No duplication of evidence persistence calls
- [ ] Import paths reference new evidence modules from brief 01
- [ ] Import paths reference new approval modules from brief 03
- [ ] `npm run test-ci` passes

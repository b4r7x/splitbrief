# 03 — Split tiered-approval.ts within approval/ folder

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Split `src/engine/orchestrator/approval/tiered-approval.ts` (465 LOC, 8 exports, 4 concerns) into focused siblings inside the existing `approval/` folder.

## Required Skills

- `/clean-code`
- `/code-audit`
- `/test-behavior-not-implementation`

## Required Reading

- `CLAUDE.md`
- `docs/STRUCTURE.md` — §Deep modules and folder colocation
- `src/engine/orchestrator/approval/tiered-approval.ts` — full file
- `src/engine/orchestrator/approval/action-classifier.ts` — existing sibling
- `src/engine/orchestrator/escalation/step.ts` — main consumer of snapshot/staging functions

## Write Ownership

```
src/engine/orchestrator/approval/tiered-approval.ts     (rewrite — keeps gateAction only)
src/engine/orchestrator/approval/file-snapshots.ts      (create)
src/engine/orchestrator/approval/staged-project.ts      (create)
src/engine/orchestrator/approval/gate-files.ts          (create)
src/engine/orchestrator/approval/tiered-approval.test.ts (split if exists)
```

## Required Behavior

### Part A: Create file-snapshots.ts

Move file snapshot management functions:
- `getChangedFilesSnapshot()` — captures initial dirty-file state
- `getChangedFilesSinceSnapshot()` — diffs against baseline
- `captureCurrentFileContents()` — preserves file content for rollback
- `restoreDirtyFilesFromSnapshot()` — restores rejected changes
- Internal helpers: `readCurrentFileContent()`, `writeCurrentFileContent()`, `uniqueProjectFiles()`
- Types: `ChangedFilesSnapshot`, `FileContentSnapshot`, `RestoreChangedFilesResult`

Dependencies: `lib/git.ts`, `lib/fs.ts`, `node:path`, `node:fs/promises`.

### Part B: Create staged-project.ts

Move staged project isolation functions:
- `createStagedProject()` — copies project for isolated retry
- `promoteStagedChanges()` — copies approved changes back
- Types: `StagedProject`, `PromoteStagedChangesResult`

Dependencies: `file-snapshots.ts` (for `readCurrentFileContent`, `writeCurrentFileContent`), `node:fs/promises`, `node:path`.

### Part C: Create gate-files.ts

Move file-level gating:
- `gateChangedFiles()` — iterates `gateAction()` over changed files
- Types: `GateChangedFilesInput`, `GateChangedFilesDecision`

Dependencies: `gateAction()` from `tiered-approval.ts`.

### Part D: Keep gateAction + grants in tiered-approval.ts

After extraction, `tiered-approval.ts` retains:
- `gateAction()` — the core approval decision function
- `upsertApprovalGrant()` — persists approval decisions
- `isConfiguredHeadless()` — approval config check
- `taskScopePatterns()` — extracts scope patterns
- Types: `GateActionInput`, `GateDecision`, `TieredApprovalRequest`, `TieredApprovalResponse`

This should be ~150-180 LOC — manageable.

### Part E: Update import sites

Search: `grep -rn "from.*tiered-approval" src/ --include='*.ts' | grep -v test`

Split imports by what each consumer actually uses:
- `escalation/step.ts` → imports `createStagedProject` from `./staged-project.js`, snapshot fns from `./file-snapshots.js`, `gateChangedFiles` from `./gate-files.js`
- `task/step.ts` → likely imports `gateAction` which stays in `tiered-approval.ts`
- Other consumers → update per actual usage

Final structure:
```
approval/
├── action-classifier.ts     (existing — unchanged)
├── tiered-approval.ts       (~160 LOC — gateAction + grants)
├── file-snapshots.ts        (~120 LOC — snapshot management)
├── staged-project.ts        (~70 LOC — isolation/promotion)
├── gate-files.ts            (~40 LOC — file-level gating)
└── *.test.ts files
```

## Tests

Split tests by module. Each new file gets colocated tests covering its exports:
- `file-snapshots.test.ts` — snapshot capture/restore with tmpdir
- `staged-project.test.ts` — create/promote with tmpdir
- `gate-files.test.ts` — multi-file gating with mock gateAction

## Verification

- [ ] No file in `approval/` exceeds 180 LOC
- [ ] `gateAction` stays in `tiered-approval.ts` (core concern)
- [ ] Snapshot/staging functions fully extracted
- [ ] All import sites updated
- [ ] `npm run test-ci` passes

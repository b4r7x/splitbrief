# 01 - Layer Inversion Fix

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Move `src/engine/orchestrator/workflow-events.ts` to `src/engine/events/workflow-events.ts` so the foundational event layer no longer imports from the orchestrator layer.

## Standard Project Constraints

- Node.js 22+, TypeScript ESM only; imports include `.js` suffixes.
- No classes. No barrel files. No useMemo/useCallback/React.memo/forwardRef.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/engine/events/types.ts` (lines 7-9 — the problematic imports)
- `src/engine/orchestrator/workflow-events.ts` (the file being moved)

## Write Ownership

Primary:
```
src/engine/events/workflow-events.ts (new location)
src/engine/events/types.ts (update import paths)
```

Secondary (import path updates — many files):
```
All files under src/ that import from orchestrator/workflow-events.js
```

## Steps

1. Move the file:
   ```bash
   mv src/engine/orchestrator/workflow-events.ts src/engine/events/workflow-events.ts
   ```

2. In `src/engine/events/types.ts`, change lines 7-9:
   ```typescript
   // FROM:
   import type { UserEditConflict, UserEditConflictAction } from '../orchestrator/workflow-events.js';
   import type { CurrentCodeContextMode, TaskContextFit } from '../orchestrator/workflow-events.js';
   import type { TaskReviewRequest } from '../orchestrator/workflow-events.js';
   // TO:
   import type { UserEditConflict, UserEditConflictAction } from './workflow-events.js';
   import type { CurrentCodeContextMode, TaskContextFit } from './workflow-events.js';
   import type { TaskReviewRequest } from './workflow-events.js';
   ```

3. Find all other importing files:
   ```bash
   grep -r "workflow-events" src/ --include="*.ts" --include="*.tsx" -l
   ```

4. For each file, update the import path. The file moved from `src/engine/orchestrator/` to `src/engine/events/`. Common patterns:
   - `src/engine/orchestrator/*.ts`: `./workflow-events.js` → `../events/workflow-events.js`
   - `src/engine/orchestrator/task/*.ts`: `../workflow-events.js` → `../../events/workflow-events.js`
   - `src/engine/orchestrator/recovery/*.ts`: `../workflow-events.js` → `../../events/workflow-events.js`
   - `src/engine/orchestrator/evidence/*.ts`: `../workflow-events.js` → `../../events/workflow-events.js`
   - `src/engine/orchestrator/evidence/review-packet/*.ts`: `../../workflow-events.js` → `../../../events/workflow-events.js`
   - `src/engine/orchestrator/user-edit/*.ts`: `../workflow-events.js` → `../../events/workflow-events.js`
   - `src/engine/orchestrator/planning/*.ts`: `../workflow-events.js` → `../../events/workflow-events.js`
   - `src/stores/**/*.ts`: adjust relative path to reach `src/engine/events/workflow-events.js`

5. Verify:
   ```bash
   npm run typecheck  # zero errors
   npm test           # all pass
   ```

## Acceptance

- `src/engine/events/types.ts` no longer imports from `../orchestrator/`
- `src/engine/orchestrator/workflow-events.ts` no longer exists
- `npm run typecheck` passes
- `npm test` passes

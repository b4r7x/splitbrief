# 05 — Split task/loop.ts within task/ folder

> Implement only this brief. Do not run git add/commit/stage/stash.
> **Depends on**: brief 02 (context-routing split). Execute after it.

## Goal

Split `src/engine/orchestrator/task/loop.ts` (511 LOC, 1 export, 7 concerns, 20+ parameter drilling) into focused siblings inside the existing `task/` folder.

## Required Skills

- `/clean-code`
- `/code-audit`
- `/test-behavior-not-implementation`

## Required Reading

- `CLAUDE.md`
- `docs/STRUCTURE.md` — §Deep modules and folder colocation
- `src/engine/orchestrator/task/loop.ts` — full file
- `src/engine/orchestrator/task/step.ts` — existing sibling
- `src/engine/orchestrator/task/pre-task.ts` — existing sibling
- `src/engine/orchestrator/task/review.ts` — existing sibling
- `src/engine/orchestrator/context-routing/route.js` — from brief 02

## Write Ownership

```
src/engine/orchestrator/task/loop.ts            (rewrite — main loop only)
src/engine/orchestrator/task/routing.ts         (create — implementer profile routing)
src/engine/orchestrator/task/task-review.ts     (create — review flow)
src/engine/orchestrator/task/budget-check.ts    (create — budget enforcement)
src/engine/orchestrator/task/loop-types.ts      (create — shared context type)
```

## Required Behavior

### Part A: Create loop-types.ts — shared context

Extract the parameter object that's drilled through the loop. Instead of 20+ parameters, define a single context type:

```typescript
import type { WorkflowContext } from '../types.js';
import type { EventBus } from '../../../events/types.js';
import type { Implementer } from '../../../implementers/types.js';
import type { ResolvedImplementerProfile } from '../../../../core/config/accessors/implementer-profiles.js';

export interface TaskLoopContext {
  ctx: WorkflowContext;
  bus: EventBus;
  profiles: ResolvedImplementerProfile[];
  languageContext: LanguageContext;
  snapshotsEnabled: boolean;
}
```

Functions in the new modules accept `TaskLoopContext` instead of individual parameters.

### Part B: Create routing.ts — implementer profile routing

Move:
- `taskConfigForProfile()` — adapts config for selected profile
- `selectedProfileFromDecision()` — extracts profile from routing decision
- `createTaskImplementer()` — factory for profile-specific implementers
- `retryProfileOverrideForTask()` — handles retry-time profile overrides

These import `routeTaskToImplementerProfile` from `../context-routing/route.js` (brief 02).

~80 LOC.

### Part C: Create task-review.ts — review flow

Move:
- `reviewTaskIfNeeded()` — routes to review logic with decision handling
- `formatTaskReviewNotes()` — formats user notes into queue message

These import from `./review.js` (existing) and `../queue.js`.

~60 LOC.

### Part D: Create budget-check.ts — budget enforcement

Move the budget enforcement block (currently lines 454-506):
- `checkBudgetAfterTask()` — wraps `enforceBudget()` and creates recovery issues on budget limits

This is a clean extraction: input is state + tokens + bus, output is recovery issue or nothing.

~60 LOC.

### Part E: Rewrite loop.ts

After extraction, `loop.ts` retains only `runTaskLoop()` — the main loop that iterates tasks. It calls:
- `hasDependencyFailed()` (keep inline — 4 lines)
- `checkUserEditConflicts()` (external)
- Functions from `./routing.js`
- `runSingleTask()` from `./step.js`
- Functions from `./task-review.js`
- `checkBudgetAfterTask()` from `./budget-check.js`
- `maybeAutoSnapshot()` (keep inline — 12 lines, called in 2 places)

Target: loop.ts ≤ 200 LOC — only the iteration logic with early exits and error handling.

### Part F: Update import sites

Search: `grep -rn "from.*task/loop" src/ --include='*.ts' | grep -v test`

`runTaskLoop` stays exported from `./task/loop.js` — callers don't change. Only internal dependencies change (the loop calls new sibling modules).

Final structure:
```
task/
├── loop.ts              (~180 LOC — main loop, entry)
├── loop-types.ts        (~20 LOC — shared context type)
├── routing.ts           (~80 LOC — profile routing)
├── task-review.ts       (~60 LOC — review flow)
├── budget-check.ts      (~60 LOC — budget enforcement)
├── step.ts              (existing — unchanged)
├── pre-task.ts          (existing — unchanged)
├── review.ts            (existing — unchanged)
├── resolve-deps.ts      (existing — unchanged)
├── apply-changed-files.ts (existing — unchanged)
├── commit.ts            (existing — unchanged)
├── retry.ts             (existing — unchanged)
├── run-implementation.ts (existing — unchanged)
├── routing-fields.ts    (existing — unchanged)
├── streaming-feed.ts    (existing — unchanged)
└── *.test.ts files
```

## Tests

Create colocated tests:
- `routing.test.ts` — test `taskConfigForProfile`, `createTaskImplementer` with mock factories
- `budget-check.test.ts` — test budget enforcement with mock enforceBudget
- `task-review.test.ts` — test review decision handling

Move relevant tests from `loop.test.ts` (if exists).

## Verification

- [ ] `loop.ts` is ≤200 LOC
- [ ] No function accepts more than 5 parameters (use context object)
- [ ] Import paths updated for context-routing from brief 02
- [ ] `runTaskLoop` still exported from `task/loop.js` (no caller changes needed)
- [ ] `npm run test-ci` passes

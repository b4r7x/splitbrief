# 02 — Split context-routing.ts into context-routing/ folder

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Split `src/engine/orchestrator/context-routing.ts` (407 LOC, 4 exports, 16 functions, 5 concerns) into a `context-routing/` folder. Also fix nested ternaries with early returns.

## Required Skills

- `/clean-code`
- `/code-audit`
- `/test-behavior-not-implementation`

## Required Reading

- `CLAUDE.md`
- `docs/STRUCTURE.md` — §Deep modules and folder colocation
- `src/engine/orchestrator/context-routing.ts` — full file
- `src/engine/orchestrator/context-routing.test.ts` — existing tests (if any)
- `src/engine/orchestrator/task/loop.ts` — main consumer

## Write Ownership

```
src/engine/orchestrator/context-routing/route.ts         (create — main routing entry)
src/engine/orchestrator/context-routing/assessment.ts    (create — profile assessment)
src/engine/orchestrator/context-routing/context-length.ts (create — resolution cascade)
src/engine/orchestrator/context-routing/estimation.ts    (create — token estimation)
src/engine/orchestrator/context-routing/helpers.ts       (create — pattern matching, ranking)
src/engine/orchestrator/context-routing/types.ts         (create — shared types)
src/engine/orchestrator/context-routing.ts               (delete after move)
src/engine/orchestrator/context-routing.test.ts          (move/split)
```

## Required Behavior

### Part A: Create types.ts

Move all exported types to `context-routing/types.ts`:
- `TaskPromptEstimateOptions`
- `ContextFitOptions`
- `RouteTaskOptions`
- `RejectedImplementerProfile`
- `RoutingDecision`
- `ContextLengthSource`
- `ResolvedProfileContextLength`
- Re-exports of `TaskContextFit`, `CurrentCodeContextMode`

### Part B: Create estimation.ts — token and fit logic

Move:
- `estimateFormattedTaskPromptTokens()` — wraps formatTaskPrompt + estimateTokens
- `classifyContextFit()` — overflow/tight/fits classification
- `currentCodeContextMode()` — function/truncated/whole-file decision

These are pure functions with no state.

### Part C: Create context-length.ts — resolution cascade

Move:
- `resolveProfileContextLength()` — 5-tier cascade (explicit → models-dev → runtime → known → fallback)

This depends on model resolution and provider utilities.

### Part D: Create assessment.ts — profile evaluation

Move:
- `assessProfile()` — combines estimation + context-length + fit + credential check
- `credentialFailureReason()` — credential validation helper
- `profileProviderId()` — provider extraction helper

### Part E: Create helpers.ts — pattern matching and ranking

Move:
- `normalizeScopePattern()` — path normalization
- `matchesTaskFilePattern()` — scope pattern matching
- `requiredWriteModeForTask()` — determines direct-write requirement
- `compareProfileRouteRank()` — cost-based sorting
- `rejectionReason()` / `selectedReason()` — diagnostic string builders
- `currentCodeReductionNote()` — reduction explanation
- `costPosture()` — cost tier description

### Part F: Create route.ts — main routing entry

Move `routeTaskToImplementerProfile()` to `route.ts`. This is the entry point — it orchestrates assessment, sorting, and selection. It imports from all sibling modules.

**Fix nested ternaries**: Replace the 4-level nested ternaries (currently ~lines 225-228) with early returns:

```typescript
// OLD:
const mode = isOverflow ? 'truncated' : isTight ? 'function' : hasDirectWrite ? 'whole-file' : 'function';

// NEW:
function resolveCodeMode(fit: TaskContextFit, hasDirectWrite: boolean): CurrentCodeContextMode {
  if (fit === 'overflow') return 'truncated';
  if (fit === 'tight') return 'function';
  if (hasDirectWrite) return 'whole-file';
  return 'function';
}
```

### Part G: Update all import sites

Search: `grep -rn "from.*context-routing" src/ --include='*.ts' | grep -v test | grep -v node_modules`

For each import site:
- `routeTaskToImplementerProfile` → import from `./context-routing/route.js`
- `estimateFormattedTaskPromptTokens` → import from `./context-routing/estimation.js`
- `RoutingDecision` type → import from `./context-routing/types.js`
- `resolveProfileContextLength` → import from `./context-routing/context-length.js`

### Part H: Delete context-routing.ts

After all functions moved and imports updated, delete the original file.

Final structure:
```
context-routing/
├── types.ts           (~40 LOC)
├── estimation.ts      (~50 LOC)
├── context-length.ts  (~50 LOC)
├── assessment.ts      (~80 LOC)
├── helpers.ts         (~80 LOC)
├── route.ts           (~80 LOC — entry point)
└── *.test.ts files
```

## Tests

Split existing tests (if any) to match the new modules. Priority test targets:
- `estimation.test.ts` — `classifyContextFit` with overflow/tight/fits cases
- `context-length.test.ts` — resolution cascade with different source availability
- `route.test.ts` — routing decisions with multiple profiles

## Verification

- [ ] No file in `context-routing/` exceeds 100 LOC
- [ ] Zero nested ternaries — all replaced with early returns or helper functions
- [ ] `grep -rn "from.*orchestrator/context-routing'" src/` returns nothing (old path gone)
- [ ] `context-routing.ts` deleted from orchestrator root
- [ ] `npm run test-ci` passes

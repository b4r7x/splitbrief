# Research: Engine SRP & DRY Refactoring

**Date**: 2026-04-01 | **Branch**: `016-engine-srp-refactor`

## 1. Planner Base Architecture

### Decision: Callback-record composition pattern (no classes)

A `createPlannerBase(config)` factory function accepts a record of callback functions (variation points) and returns a complete `PlannerBackend`. Each planner defines only its unique invoke/availability functions.

### Rationale
- Constitution Principle IV mandates "zero classes, no inheritance, no `this` binding"
- Function composition with closures handles all variation points (session chaining, programmatic SDK, stdin-based escalation)
- Single level of indirection — the base factory closes over callbacks, no hidden dispatch
- Preserves existing `PlannerBackend` interface — zero changes to consumers (orchestrator, factory)

### Alternatives Considered
- **Abstract base class with method overrides**: Rejected — violates Principle IV (zero classes)
- **Mixin functions**: Rejected — more complex than callback records for this use case
- **Higher-order function per method (planWithSpawn, escalateWithSpawn)**: Rejected — too granular, 6 separate HOFs vs 1 factory

### Key Types

```typescript
interface InvokeResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

type InvokeFn = (
  prompt: string,
  projectDir: string,
  onOutput: (text: string) => void,
  onQuestion?: (questions: ClarificationQuestion[]) => void,
) => Promise<InvokeResult>;

interface PlannerBaseConfig {
  name: string;
  pricingKey: string;
  invokePlan: InvokeFn;
  invokeEscalate: InvokeFn;
  isAvailable: () => Promise<boolean>;
  getVersion: () => Promise<string | null>;
  escalateHintSuccess?: (result: InvokeResult) => boolean;
  escalateFullPostProcess?: (task, result, extracted, projectDir) => EscalationResult;
}
```

### Variation Point Handling

| Planner | Variation | How Handled |
|---------|-----------|-------------|
| `claude-code` | Session chaining across 4 plan phases | Mutable `sessionId` in closure of `invokePlan` |
| `claude-code` | Stdin-based escalation (different from plan spawn) | Separate `invokeEscalate` slot |
| `claude-code` | File write on `escalateFull` | `escalateFullPostProcess` override |
| `agent-sdk` | Programmatic SDK (no subprocess) | `runQuery` wrapped as `InvokeFn` — same interface |
| `aider` | Different args per phase / config-driven model | Closed over config in `invokePlan` |
| `shell` | Configurable output format (text/jsonl/stream-json) | Closed over config in `invokePlan` |
| `shell` | Slight `buildProjectContext` variation (no README) | Use standard version — README omission was accidental |

### Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Total planner LOC | ~2,150 | ~770 |
| Per-planner avg LOC | ~360 | ~105 |
| `base.ts` (new) | 0 | ~130 |
| Reduction | — | ~64% |

---

## 2. Orchestrator Decomposition Strategy

### Decision: Split into `src/engine/orchestrator/` directory with 6 modules

The original `orchestrator.ts` becomes a directory. Consumer imports change from `orchestrator.js` to `orchestrator/index.js` (4 import sites).

### Rationale
- 908 lines with 7+ responsibilities violates SRP severely
- `runWorkflow` at 407 lines with 5 nesting levels is the hardest function to debug
- Pure functions (cost, tokens) are trivially extractable with zero risk
- Retry/escalation cascade is self-contained and called from one site

### Module Design

| File | Contents | Lines | Dependencies |
|------|----------|-------|--------------|
| `orchestrator/cost.ts` | `estimateCostSavings`, `calculateCostBreakdown`, `buildSummary` | ~60 | pricing.js, types |
| `orchestrator/tokens.ts` | `addPlannerUsage`, `addImplementerUsage`, `addEscalationUsage`, `tokenDelta` | ~55 | types |
| `orchestrator/helpers.ts` | `buildContext`, `emit`, `emitValidationStart`, `allValidationsPassed`, `hasDependencyFailed`, `persistClarifications`, `supportsConversational`, `emitValidationResult` (new shared helper) | ~80 | types, utils/fs |
| `orchestrator/task-runner.ts` | `validateCommitAndAdvance`, `handleRetryAndEscalation`, `RetryResult` type | ~165 | helpers, tokens, validator, implementer, escalation templates |
| `orchestrator/final-review.ts` | `runFinalReview` | ~75 | claude-stream, utils/process |
| `orchestrator/index.ts` | `runWorkflow` (slimmed main loop), re-exports | ~180 | all above modules |

### Dependency Graph (no cycles)

```
index.ts
  ├── cost.ts          (leaf)
  ├── tokens.ts        (leaf)
  ├── helpers.ts       (leaf)
  ├── final-review.ts  (leaf)
  └── task-runner.ts
        ├── helpers.ts
        └── tokens.ts
```

### Key Deduplication

- 4x validation-event emission → 1 `emitValidationResult()` helper
- 2x approval loop (spec + plan) → 1 `runApprovalLoop()` parameterized function
- 4x inline `allValidationsPassed` logic → use existing helper function
- 3x file-reading for `task.currentCode` → 1 `refreshTaskCode()` helper

### Import Migration

4 consumer files need `orchestrator.js` → `orchestrator/index.js`:
- `src/hooks/use-workflow.ts`
- `tests/orchestrator.test.ts`
- `tests/summary.test.ts`
- `tests/integration/tokens.integration.test.ts`

---

## 3. Implementer Layer Refactoring

### Decision: Extract `apply.ts` + `openai-stream.ts`, unify implement/retry

### Rationale
- Upward dependency (`implementers/shell.ts` → `implementer.ts`) is a circular smell
- `implementTask`/`retryTask` share 90% code — only prompt and temperature differ
- `streamCompletion` is a reusable OpenAI client wrapper mixed with task logic

### New Files

| File | Contents | Lines |
|------|----------|-------|
| `engine/apply.ts` | `applyCode` function (file writing + search/replace) | ~65 |
| `engine/openai-stream.ts` | `streamCompletion`, `CompletionResult` interface | ~90 |

### Modified Files

| File | Change | Lines After |
|------|--------|-------------|
| `engine/implementer.ts` | Remove `applyCode` + `streamCompletion`, add `runOpenAIImplementer` shared core | ~120 |
| `engine/implementers/shell.ts` | Import `applyCode` from `../apply.js`, add `runShellImplementer` shared core | ~230 |
| `tests/implementer.test.ts` | Update `applyCode` import path | — |

### Dependency Graph (after)

```
orchestrator
  └── implementer.ts  (PUBLIC API UNCHANGED)
        ├── openai-stream.ts  (NEW)
        │     └── providers.ts
        ├── apply.ts  (NEW)
        │     └── utils/fs.ts
        ├── implementers/shell.ts
        │     ├── apply.ts  (was ../implementer.js — NO MORE upward dep)
        │     └── extractor.ts
        ├── implementers/agent.ts  (unchanged)
        ├── spec/formatter.ts
        ├── extractor.ts
        └── utils/diff.ts
```

---

## 4. Dead Code Inventory

| Item | File | Action |
|------|------|--------|
| `escalator.ts` (22 lines, zero callers) | `src/engine/escalator.ts` | Delete |
| `detectLocalModels()` (never called) | `src/engine/providers.ts:26-57` | Delete function |
| `activeProcesses` import (unused) | `src/engine/planners/opencode.ts:15` | Remove import |
| `codeContext = 0` placeholder (never used) | `src/engine/spec/formatter.ts:54` | Remove field |
| `r.isResult ? r.text : r.text` (dead ternary) | `src/engine/planners/shell.ts:74` | Simplify to `r.text` |
| `isMedium`, `isLarge` (unused returns) | `src/hooks/use-terminal-size.ts:34-35` | Remove |
| Unused `import React` (3 files) | `ui/help-overlay.tsx`, `ui/slash-suggestions.tsx`, `ui/command-palette.tsx` | Remove |
| `ExtendedSummary` redundant type | `ui/summary.tsx:25-30` | Import from types.ts |
| `TaskTokenUsage` + `CostBreakdown` re-declarations | `ui/summary.tsx:6-23` | Import from types.ts |

---

## 5. Anti-Slop Cleanup Inventory

| Category | Count | Action |
|----------|-------|--------|
| Unnecessary comments (restate code) | ~25 | Delete |
| `catch (err: any)` → `catch (err: unknown)` | 3 in validator.ts | Fix with type narrowing |
| `?? undefined` on nullable types | 6 in implementer + shell | Remove or fix upstream type |
| `as any` in `use-config.ts` | 2 | Use proper type |
| `as any` in error handling | ~10 across engine | Replace with `unknown` + narrowing |

---

## 6. React Anti-Pattern Fixes

| Issue | File | Fix |
|-------|------|-----|
| Side effects during render | `ui/picker.tsx:26-41` | Move `onError()` + `setState` to `useEffect` |
| Sync I/O every render | `hooks/use-config.ts:12-19` | Wrap in `useMemo` |
| `useEffect` for sync derived state | `hooks/use-skills.ts:9-12` | Use `useMemo` |
| Sync `readFileSync` in `useEffect` | `ui/review-view.tsx:50-56` | Use lazy `useState` initializer |
| `prevValue` sync-from-props | `ui/input-bar.tsx:43-47` | Reset in value-change handlers directly |
| `prevExternalOffset` sync-from-props | `ui/review-view.tsx:58-61` | Make fully uncontrolled + key-based reset |

---

## 7. UI Deduplication

| Issue | Files | Fix |
|-------|-------|-----|
| 3x `truncate` copies | `picker-utils.ts`, `header.tsx`, `sidebar.tsx` | Delete local copies, import from `picker-utils.ts` |
| 2x `renderMarkdownLine` | `event-card.tsx`, `review-view.tsx` | Extract to `ui/markdown.tsx` |
| Theme inconsistency (6 components call `getTheme()` ignoring prop) | `summary.tsx`, `pipeline-bar.tsx`, `header.tsx`, `picker.tsx`, `task-summary.tsx`, `cost-footer.tsx` | Accept theme as prop |

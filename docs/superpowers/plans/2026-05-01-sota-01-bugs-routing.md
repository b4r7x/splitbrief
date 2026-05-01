# SOTA 01: Fix Dead Field + Extract Routing Fields

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax. After ALL tasks: run `npm run test-ci` to verify.

**Goal:** Fix `worktreeName` dead field bug and DRY-extract duplicated routing decision spread.

**DEPENDENCY:** Task 2 and Task 3 create `routing-fields.ts` which imports from `workflow-events.js`. If SOTA-02 (layer inversion) has already run, import from `../../events/workflow-events.js`. If SOTA-02 has NOT run yet, import from `../workflow-events.js` (old location). The code below assumes SOTA-02 has NOT run yet — adjust the import path if it has.

**NEVER run `git commit` or `git add`** — leave all changes unstaged.

---

### Task 1: Fix dead `worktreeName` field

**Problem:** `RouteData` declares `worktreeName?: string` but `NavigateArgs` doesn't include it, so `navigate()` never writes it. UI header reads `undefined`.

**Files:**
- Modify: `src/stores/navigation/router.ts`

- [ ] **Step 1: Add `worktreeName` to `NavigateArgs`**

In `src/stores/navigation/router.ts`, find the `NavigateArgs` type. The `workflow` variant is:

```typescript
  | { to: 'workflow'; feature: string; resumeState?: WorkflowState | undefined; sessionId?: string | undefined; attach?: WorkflowAttach | undefined; readiness?: ReadinessReport | undefined }
```

Replace with:

```typescript
  | { to: 'workflow'; feature: string; resumeState?: WorkflowState | undefined; sessionId?: string | undefined; worktreeName?: string | undefined; attach?: WorkflowAttach | undefined; readiness?: ReadinessReport | undefined }
```

- [ ] **Step 2: Write `worktreeName` in `navigate()` function**

In same file, find `case 'workflow':` inside the `navigate` function. The `store.set(...)` call there currently does NOT include `worktreeName`. Add it:

```typescript
    case 'workflow':
      store.set({
        screen: 'workflow',
        feature: args.feature,
        resumeState: args.resumeState,
        sessionId: args.sessionId,
        worktreeName: args.worktreeName,
        attach: args.attach,
        readiness: args.readiness,
      });
      return;
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

---

### Task 2: Create `buildRoutingEventFields` helper

**Problem:** Same 8-field spread copied 3 times in `step.ts`.

**Files:**
- Create: `src/engine/orchestrator/task/routing-fields.ts`

- [ ] **Step 1: Create the file**

Create `src/engine/orchestrator/task/routing-fields.ts` with this exact content:

```typescript
import type { TaskContextFit, CurrentCodeContextMode } from '../workflow-events.js';

export interface RoutingDecision {
  fit: TaskContextFit;
  estimatedTokens: number;
  untruncatedEstimatedTokens: number;
  contextLength?: number | undefined;
  currentCodeTruncated: boolean;
  currentCodeContextMode: CurrentCodeContextMode;
  costPosture: string;
  reason: string;
}

export function buildRoutingEventFields(decision: RoutingDecision | undefined): Record<string, unknown> {
  if (decision === undefined) return {};
  return {
    contextFit: decision.fit,
    estimatedTokens: decision.estimatedTokens,
    untruncatedEstimatedTokens: decision.untruncatedEstimatedTokens,
    ...(decision.contextLength !== undefined && { contextLength: decision.contextLength }),
    currentCodeTruncated: decision.currentCodeTruncated,
    currentCodeContextMode: decision.currentCodeContextMode,
    costPosture: decision.costPosture,
    routingReason: decision.reason,
  };
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npm run typecheck`
Expected: PASS

---

### Task 3: Replace routing spreads in `step.ts`

**Files:**
- Modify: `src/engine/orchestrator/task/step.ts`

- [ ] **Step 1: Add import**

At top of `src/engine/orchestrator/task/step.ts`, add:

```typescript
import { buildRoutingEventFields } from './routing-fields.js';
```

- [ ] **Step 2: Replace first routing spread (around line 186-196)**

Find this pattern (after `...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),`):

```typescript
      ...(wctx.routingDecision !== undefined && {
        contextFit: wctx.routingDecision.fit,
        estimatedTokens: wctx.routingDecision.estimatedTokens,
        untruncatedEstimatedTokens: wctx.routingDecision.untruncatedEstimatedTokens,
        ...(wctx.routingDecision.contextLength !== undefined && { contextLength: wctx.routingDecision.contextLength }),
        currentCodeTruncated: wctx.routingDecision.currentCodeTruncated,
        currentCodeContextMode: wctx.routingDecision.currentCodeContextMode,
        costPosture: wctx.routingDecision.costPosture,
        routingReason: wctx.routingDecision.reason,
      }),
```

Replace with:

```typescript
      ...buildRoutingEventFields(wctx.routingDecision),
```

- [ ] **Step 3: Replace second routing spread (around line 212-221)**

Find the same pattern repeated in the `publishTaskStart(...)` call. Same replacement:

```typescript
      ...buildRoutingEventFields(wctx.routingDecision),
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS

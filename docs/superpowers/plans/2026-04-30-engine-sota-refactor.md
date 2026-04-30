# Engine SOTA Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `src/engine/` to 5/5 on all quality categories by fixing critical architecture violations, DRY duplications, SRP violations, error handling bugs, and performance issues identified in the SOTA audit (`docs/audits/engine-audit-2026-04-30.md`).

**Architecture:** The engine is a zero-React, zero-class workflow orchestrator using pure functions, module-scoped state, ESM imports, and Zod validation. Changes fix violated invariants (engine→React dependency), eliminate cross-module duplication (planner/implementer dispatch), split 1000+ LOC files per project rules, and fix semantic bugs in the hook system.

**Tech Stack:** Node.js 22+, TypeScript 6.x (strict), ESM only (`.js` extensions), Vitest 4.x, Zod 4.x, Biome 2.x

**CRITICAL CONSTRAINT:** NEVER run `git add`, `git commit`, or `git stage`. Leave ALL changes as unstaged modifications. A pre-commit hook blocks these commands. Verify work with `npm run test-ci` only.

**Verification command (run after every task):**
```bash
npm run test-ci
```
This runs: `tsc --noEmit` → `biome check` → `vitest run`

---

## File Structure Overview

### Files to CREATE (new modules)

| Path | Responsibility |
|---|---|
| `src/engine/providers/dispatch-stream.ts` | Unified Anthropic/OpenAI streaming dispatch (eliminates planner↔implementer duplication) |
| `src/engine/orchestrator/explain/routing.ts` | Moved from `explain-routing.ts` |
| `src/engine/orchestrator/explain/artifacts.ts` | Moved from `explain-artifacts.ts` |
| `src/engine/orchestrator/explain/format.ts` | Moved from `explain-format.ts` |
| `src/engine/orchestrator/explain/sections.ts` | Moved from `explain-sections.ts` |
| `src/engine/orchestrator/explain/types.ts` | Moved from `explain-types.ts` |
| `src/engine/orchestrator/explain/explain.ts` | Moved from `explain.ts` (entry point) |
| `src/engine/orchestrator/drift/drift.ts` | Moved from `drift.ts` |
| `src/engine/orchestrator/drift/drift-chain.ts` | Moved from `drift-chain.ts` |
| `src/engine/orchestrator/drift/drift-chain-state.ts` | Moved from `drift-chain-state.ts` |

### Files to MODIFY (major changes)

| Path | Change |
|---|---|
| `src/engine/planners/base.ts` | Extract `runSinglePhasePlanning()`, `formatRepoMapBlock()`, fix wrong phase label |
| `src/engine/planners/api.ts` | Use shared `dispatchStreamCompletion()` |
| `src/engine/implementers/api.ts` | Use shared `dispatchStreamCompletion()`, delete redundant `buildPrompt`/`buildRetryPrompt` |
| `src/engine/implementers/base.ts:19` | Remove orchestrator import, accept event publisher as parameter |
| `src/engine/hooks/run-pre-hook.ts:30` | Fix deny/on_failure conflation |
| `src/engine/hooks/dispatch.ts:83-91` | Fix `validateOutcome` fail-open |
| `src/engine/hooks/dispatch.ts:60-64` | Fix ENOENT string-sniffing |
| `src/engine/hooks/sink.ts:27` | Fix `as Phase` hard-coded fallback |
| `src/engine/events/sinks/tui.ts` | Move to features layer (delete from engine) |
| `src/engine/orchestrator/approvals-store.ts:29-42` | Delete `readApprovalsStoreStrict` |
| `src/engine/codebase/graph.ts:36-49` | Pre-build resolution Map for O(1) lookups |

### Files to DELETE

| Path | Reason |
|---|---|
| `src/engine/orchestrator/explain-routing.ts` | Moved to `orchestrator/explain/` |
| `src/engine/orchestrator/explain-artifacts.ts` | Moved to `orchestrator/explain/` |
| `src/engine/orchestrator/explain-format.ts` | Moved to `orchestrator/explain/` |
| `src/engine/orchestrator/explain-sections.ts` | Moved to `orchestrator/explain/` |
| `src/engine/orchestrator/explain-types.ts` | Moved to `orchestrator/explain/` |
| `src/engine/orchestrator/explain.ts` | Moved to `orchestrator/explain/` |
| `src/engine/orchestrator/explain.test.ts` | Moved to `orchestrator/explain/` |
| `src/engine/orchestrator/drift.ts` | Moved to `orchestrator/drift/` |
| `src/engine/orchestrator/drift.test.ts` | Moved to `orchestrator/drift/` |
| `src/engine/orchestrator/drift-chain.ts` | Moved to `orchestrator/drift/` |
| `src/engine/orchestrator/drift-chain.test.ts` | Moved to `orchestrator/drift/` |
| `src/engine/orchestrator/drift-chain-state.ts` | Moved to `orchestrator/drift/` |
| `src/engine/orchestrator/drift-chain-state.test.ts` | Moved to `orchestrator/drift/` |
| `src/engine/orchestrator/drift-chain-integration.test.ts` | Moved to `orchestrator/drift/` |

---

## Phase 1: Architecture Critical

These must be done FIRST and SEQUENTIALLY — they affect the import graph globally.

---

### Task 1: Fix hook system semantic bugs

**Priority:** Critical security fix — must land before anything else.

**Files:**
- Modify: `src/engine/hooks/run-pre-hook.ts:28-36`
- Modify: `src/engine/hooks/dispatch.ts:59-65, 83-91`
- Modify: `src/engine/hooks/sink.ts:27`
- Test: `src/engine/hooks/run-pre-hook.test.ts`
- Test: `src/engine/hooks/dispatch.test.ts`
- Test: `src/engine/hooks/sink.test.ts`

- [ ] **Step 1: Read existing test files to understand current coverage**

Read `src/engine/hooks/run-pre-hook.test.ts`, `src/engine/hooks/dispatch.test.ts`, and `src/engine/hooks/sink.test.ts` fully.

- [ ] **Step 2: Write failing test for deny/on_failure bug**

In `src/engine/hooks/run-pre-hook.test.ts`, add test:

```typescript
it('honors deny outcome regardless of on_failure setting', async () => {
  const hooks: HooksConfig = {
    pre_task: [{
      kind: 'module',
      path: './deny-hook.js',
      on_failure: 'warn',  // <-- previously this would swallow the deny
      timeout_ms: 5000,
    }],
  };
  // Mock loadHookModule to return a deny outcome
  // (existing test patterns in the file show how)
  const result = await runPreHooks(hooks, 'pre_task', fakeEvent, ctx);
  expect(result.allow).toBe(false);
  expect(result.reason).toContain('denied');
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run src/engine/hooks/run-pre-hook.test.ts -t "honors deny"
```
Expected: FAIL — currently deny is gated on `on_failure === 'block'`

- [ ] **Step 4: Fix the deny/on_failure conflation**

In `src/engine/hooks/run-pre-hook.ts`, replace lines 28-36 with:

```typescript
  const entries = hooks?.[event] ?? [];
  for (const entry of entries) {
    const outcome = await runHook(entry, eventPayload, ctx);
    if (outcome.kind === 'deny') {
      return { allow: false, reason: outcome.message ?? `${event} hook denied` };
    }
    if (outcome.kind === 'crash' && entry.on_failure === 'block') {
      return { allow: false, reason: outcome.message };
    }
  }
  return { allow: true };
```

The key change: `outcome.kind === 'deny'` is now honored UNCONDITIONALLY. Only `crash` outcomes respect `on_failure`.

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/engine/hooks/run-pre-hook.test.ts
```
Expected: ALL PASS

- [ ] **Step 6: Write failing test for validateOutcome fail-open bug**

In `src/engine/hooks/dispatch.test.ts`, add test:

```typescript
it('returns warn for unrecognized outcome shape instead of silent allow', async () => {
  // Create a module hook that returns { kind: 'denyy' } (typo)
  // The current code returns { kind: 'allow' } — WRONG
  // Expected: { kind: 'warn', message: '...' }
});
```

- [ ] **Step 7: Fix validateOutcome in dispatch.ts**

Replace `src/engine/hooks/dispatch.ts:83-91`:

```typescript
function validateOutcome(result: unknown): HookOutcome {
  if (result !== null && typeof result === 'object' && 'kind' in result) {
    const kind = (result as { kind: unknown }).kind;
    if (kind === 'allow' || kind === 'deny' || kind === 'warn' || kind === 'crash') {
      return result as HookOutcome;
    }
  }
  return { kind: 'warn', message: 'hook returned unrecognized outcome shape' };
}
```

- [ ] **Step 8: Fix ENOENT string-sniffing in dispatch.ts**

Replace `src/engine/hooks/dispatch.ts:59-65`:

```typescript
  const loaded = await loadHookModule(entry.path, ctx.projectDir);
  if (!loaded.ok) {
    if (isENOENT(loaded.error) || loaded.reason.toLowerCase().includes('cannot find') || loaded.reason.toLowerCase().includes('module not found')) {
      return { kind: 'warn', message: `hook module not found: ${entry.path}` };
    }
    return failureOutcome(entry, `failed to load module: ${loaded.reason}`);
  }
```

Note: Check how `loadHookModule` returns errors — it may return a `{ ok: false, reason: string }` shape. If it has an `error` property, use `isENOENT(loaded.error)`. If not, add the error to `LoadModuleResult` type.

- [ ] **Step 9: Fix sink.ts phase coercion**

Replace `src/engine/hooks/sink.ts:27`:

```typescript
  const phase: Phase = ('phase' in event && typeof (event as { phase: unknown }).phase === 'string')
    ? (event as { phase: string }).phase as Phase
    : 'implementing';
```

This at least validates it's a string before casting. Alternatively, define a `getEventPhase` helper:

```typescript
function getEventPhase(event: EngineEvent): Phase {
  if ('phase' in event && typeof (event as Record<string, unknown>).phase === 'string') {
    return (event as Record<string, unknown>).phase as Phase;
  }
  return 'implementing';
}
```

- [ ] **Step 10: Run full hook test suite**

```bash
npx vitest run src/engine/hooks/
```
Expected: ALL PASS

- [ ] **Step 11: Verify no regressions**

```bash
npm run test-ci
```
Expected: PASS

---

### Task 2: Remove `readApprovalsStoreStrict` duplicate

**Files:**
- Modify: `src/engine/orchestrator/approvals-store.ts`
- Modify: Any file importing `readApprovalsStoreStrict` (search first)
- Test: `src/engine/orchestrator/approvals-store.test.ts`

- [ ] **Step 1: Find all consumers**

```bash
grep -r "readApprovalsStoreStrict" src/ --include="*.ts" -l
```

- [ ] **Step 2: Replace all usages with `readApprovalsStore`**

Both functions are byte-identical. Replace every import of `readApprovalsStoreStrict` with `readApprovalsStore`.

- [ ] **Step 3: Delete the duplicate function**

Remove lines 25-42 from `src/engine/orchestrator/approvals-store.ts` (the JSDoc comment + `readApprovalsStoreStrict` function + export).

- [ ] **Step 4: Update tests**

In `src/engine/orchestrator/approvals-store.test.ts`, replace any tests targeting `readApprovalsStoreStrict` to test `readApprovalsStore` instead.

- [ ] **Step 5: Verify**

```bash
npm run test-ci
```

---

### Task 3: Extract shared stream dispatch (DRY critical cross-module)

**Files:**
- Create: `src/engine/providers/dispatch-stream.ts`
- Modify: `src/engine/planners/api.ts:27-61`
- Modify: `src/engine/implementers/api.ts:29-74`
- Test: existing tests cover via integration

- [ ] **Step 1: Create `src/engine/providers/dispatch-stream.ts`**

```typescript
import type { InvokeResult } from '../runners/types.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import { streamCompletion, type StreamClient } from './openai-stream.js';
import { streamAnthropicCompletion } from './anthropic/stream.js';
import { providerError } from './errors.js';

interface StreamDispatchOpts {
  provider: string;
  client: StreamClient | null;
  apiKey: string;
  apiBase: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  onProgress: (text: string) => void;
  maxTokens?: number;
  signal?: AbortSignal;
  effort?: EffortLevel;
  images?: Attachment[];
}

export async function dispatchStreamCompletion(opts: StreamDispatchOpts): Promise<InvokeResult> {
  const { provider, client, apiKey, apiBase, model, messages, temperature, onProgress, maxTokens, signal, effort, images } = opts;

  if (provider === 'anthropic') {
    return streamAnthropicCompletion({
      apiKey,
      apiBase,
      model,
      messages,
      temperature,
      onProgress,
      ...(maxTokens !== undefined && { maxTokens }),
      ...(signal !== undefined && { signal }),
      ...(effort !== undefined && { effort }),
      ...(images && images.length > 0 ? { images } : {}),
    });
  }

  if (!client) throw providerError.expectedOpenAIClient(provider);

  return streamCompletion(client, model, messages, {
    temperature,
    onProgress,
    endpoint: { provider, apiBase },
    ...(maxTokens !== undefined && { maxTokens }),
    ...(signal !== undefined && { signal }),
    ...(effort !== undefined && { effort }),
    ...(images && images.length > 0 ? { images } : {}),
  });
}
```

- [ ] **Step 2: Refactor `planners/api.ts` to use `dispatchStreamCompletion`**

Replace the `invokeApi` function (lines 27-61) with:

```typescript
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';

async function invokeApi(
  client: OpenAI | null,
  model: string,
  planner: { provider: string; apiBase?: string | undefined; apiKey: string },
  prompt: string,
  onOutput: (text: string) => void,
  priorMessages?: PriorMessage[] | undefined,
  effort?: EffortLevel | undefined,
  images?: Attachment[] | undefined,
): Promise<InvokeResult> {
  const messages = buildMessages(prompt, priorMessages);
  return dispatchStreamCompletion({
    provider: planner.provider,
    client: client as StreamClient | null,
    apiKey: planner.apiKey,
    apiBase: planner.apiBase ?? '',
    model,
    messages,
    temperature: 0.3,
    onProgress: onOutput,
    effort,
    images,
  });
}
```

Remove the now-unused imports: `streamCompletion`, `StreamClient`, `streamAnthropicCompletion`, `providerError`.

- [ ] **Step 3: Refactor `implementers/api.ts` to use `dispatchStreamCompletion`**

Replace the inline `invoke` function body (lines 52-73) with:

```typescript
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';

// Inside the invoke function:
return dispatchStreamCompletion({
  provider: impl.provider,
  client: client as StreamClient | null,
  apiKey: resolvedApiKey,
  apiBase: impl.apiBase ?? '',
  model,
  messages,
  temperature,
  onProgress: onOutput,
  maxTokens,
  signal,
});
```

Remove unused imports: `streamCompletion`, `StreamClient`, `streamAnthropicCompletion`, `providerError`.

- [ ] **Step 4: Delete redundant `buildPrompt`/`buildRetryPrompt` in `implementers/api.ts`**

Remove lines 76-82 entirely. The base already provides these defaults.

- [ ] **Step 5: Verify**

```bash
npm run test-ci
```

---

### Task 4: Extract `runSinglePhasePlanning` and fix planners DRY

**Files:**
- Modify: `src/engine/planners/base.ts:76-223`
- Test: `src/engine/planners/base.test.ts`

- [ ] **Step 1: Extract `formatRepoMapBlock` helper**

At the top of `src/engine/planners/base.ts` (after imports), add:

```typescript
function formatRepoMapBlock(codebaseContext: string | undefined): string {
  return codebaseContext ? `<repo-map>\n${codebaseContext}\n</repo-map>\n\n` : '';
}
```

Replace all 3 occurrences of the inline template (lines 86, 152, 192) with `formatRepoMapBlock(codebaseContext)`.

- [ ] **Step 2: Extract `runSinglePhasePlanning` helper**

After the `createPlannerBase` function definition, add an internal helper:

```typescript
async function runSinglePhasePlanning(
  config: PlannerBaseConfig,
  promptBuilder: (feature: string, projectContext: string) => string,
  phaseName: string,
  feature: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
  codebaseContext: string | undefined,
): Promise<PlanResult> {
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const repoMapBlock = formatRepoMapBlock(codebaseContext);
  const prompt = repoMapBlock + promptBuilder(feature, projectContext);

  callbacks.onPhase?.(phaseName);
  const buffer = createTranscriptBuffer(
    projectDir, callbacks.sessionId ?? '', 'planning', callbacks.persistTranscript ?? true,
  );
  const priorMessages = callbacks.priorMessages;
  let effectivePrompt = prompt;
  if (priorMessages && priorMessages.length > 0 && !config.consumesPriorMessages) {
    effectivePrompt = formatMessagesForCli(priorMessages) + prompt;
  }
  const images = callbacks.attachments && callbacks.attachments.length > 0 ? callbacks.attachments : undefined;
  const result = await config.invokePlan({
    prompt: effectivePrompt, projectDir, callbacks: {
      onOutput: (text) => { callbacks.onOutput(text); buffer.append(text); },
      onQuestion: callbacks.onQuestion,
      onSessionId: callbacks.onSessionId,
      onSessionExpired: callbacks.onSessionExpired,
    },
    ...(config.consumesPriorMessages && priorMessages ? { priorMessages } : {}),
    ...(images ? { images } : {}),
  });
  buffer.flush();

  const tasksContent = config.readPhaseOutput
    ? config.readPhaseOutput(TASKS_FILE, result.text, projectDir, callbacks.sessionId)
    : result.text;
  const tasks = parseTasks(tasksContent);
  const rawOutput = tasksContent !== result.text ? result.text : undefined;
  return { spec: '', plan: '', tasks, usage: result.usage, phases: [{ text: tasksContent, filename: TASKS_FILE, rawOutput }] };
}
```

- [ ] **Step 3: Replace `quickPlan` and `instantPlan` with delegations**

```typescript
async quickPlan(
  feature: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
  codebaseContext?: string,
): Promise<PlanResult> {
  return runSinglePhasePlanning(config, buildQuickPlanPrompt, 'quick-planning', feature, projectDir, callbacks, codebaseContext);
},

async instantPlan(
  feature: string,
  projectDir: string,
  callbacks: PlannerCallbacks,
  codebaseContext?: string,
): Promise<PlanResult> {
  return runSinglePhasePlanning(config, buildInstantPrompt, 'instant-planning', feature, projectDir, callbacks, codebaseContext);
},
```

Note the phase name fix: `instantPlan` now emits `'instant-planning'` instead of `'quick-planning'`.

- [ ] **Step 4: Also replace `repoMapBlock` in the `plan` method (line 86)**

```typescript
const repoMapBlock = formatRepoMapBlock(codebaseContext);
```

- [ ] **Step 5: Verify**

```bash
npm run test-ci
```

---

### Task 5: Fix upward dependency — implementers importing from orchestrator

**Files:**
- Modify: `src/engine/implementers/base.ts:19`
- Modify: `src/engine/orchestrator/events.ts` (verify exports exist)
- Modify: `src/engine/implementers/types.ts` (add publisher callback type)
- Modify: All callers of `createImplementerBase` (inject the publisher)

- [ ] **Step 1: Understand the current dependency**

`src/engine/implementers/base.ts:19` imports `publishImplementerGenerateRunning`, `publishImplementerGenerateDone`, `publishImplementerGenerateFailed` from `../orchestrator/events.js`.

These are used at lines ~136-200 in `runPipeline` to emit lifecycle events.

- [ ] **Step 2: Add publisher interface to implementer types**

In `src/engine/implementers/types.ts`, add:

```typescript
export interface ImplementerPublisher {
  publishRunning(phase: Phase): void;
  publishDone(phase: Phase, usage: TokenDelta | null): void;
  publishFailed(phase: Phase, error: string): void;
}
```

- [ ] **Step 3: Add optional publisher to `ImplementerBaseConfig`**

In `src/engine/implementers/base.ts`, add `publisher?: ImplementerPublisher` to the base config type, and use it instead of the direct imports:

```typescript
// Replace:
if (bus && phase) { publishImplementerGenerateRunning(bus, phase); }
// With:
opts.publisher?.publishRunning(phase);
```

- [ ] **Step 4: Remove the orchestrator import**

Delete line 19 from `src/engine/implementers/base.ts`:
```typescript
// DELETE: import { publishImplementerGenerateRunning, publishImplementerGenerateDone, publishImplementerGenerateFailed } from '../orchestrator/events.js';
```

- [ ] **Step 5: Wire publisher at the orchestrator call site**

In `src/engine/orchestrator/task-step.ts` (or wherever implementers are instantiated), pass a publisher that wraps the event bus:

```typescript
publisher: {
  publishRunning: (phase) => publishImplementerGenerateRunning(bus, phase),
  publishDone: (phase, usage) => publishImplementerGenerateDone(bus, phase, usage),
  publishFailed: (phase, error) => publishImplementerGenerateFailed(bus, phase, error),
}
```

- [ ] **Step 6: Verify no orchestrator imports remain in implementers**

```bash
grep -r "from.*orchestrator" src/engine/implementers/ --include="*.ts"
```
Expected: 0 results

- [ ] **Step 7: Verify**

```bash
npm run test-ci
```

---

## Phase 2: File Organization (orchestrator directory restructuring)

---

### Task 6: Move explain files into `orchestrator/explain/` subdirectory

**Files:**
- Move: `orchestrator/explain-routing.ts` → `orchestrator/explain/routing.ts`
- Move: `orchestrator/explain-artifacts.ts` → `orchestrator/explain/artifacts.ts`
- Move: `orchestrator/explain-format.ts` → `orchestrator/explain/format.ts`
- Move: `orchestrator/explain-sections.ts` → `orchestrator/explain/sections.ts`
- Move: `orchestrator/explain-types.ts` → `orchestrator/explain/types.ts`
- Move: `orchestrator/explain.ts` → `orchestrator/explain/explain.ts`
- Move: `orchestrator/explain.test.ts` → `orchestrator/explain/explain.test.ts`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p src/engine/orchestrator/explain
```

- [ ] **Step 2: Move each file (copy content, fix internal imports)**

For each file:
1. Read the original
2. Write to new location with updated relative imports (paths change by one level deeper)
3. Delete the original

Example import change in `explain.ts`:
```typescript
// Before: import { foo } from './explain-routing.js';
// After:  import { foo } from './routing.js';

// Before: import { bar } from './events.js';
// After:  import { bar } from '../events.js';
```

- [ ] **Step 3: Update all external consumers**

Search for imports of the old paths:
```bash
grep -r "from.*explain-routing\|from.*explain-artifacts\|from.*explain-format\|from.*explain-sections\|from.*explain-types\|from.*\/explain\.js" src/engine/ --include="*.ts" -l
```

Update each consumer to import from the new path:
```typescript
// Before: import { ... } from './explain-routing.js';
// After:  import { ... } from './explain/routing.js';

// Before: import { ... } from './explain.js';
// After:  import { ... } from './explain/explain.js';
```

- [ ] **Step 4: Delete old files**

Remove all 7 original files from `src/engine/orchestrator/`.

- [ ] **Step 5: Verify**

```bash
npm run test-ci
```

---

### Task 7: Move drift files into `orchestrator/drift/` subdirectory

**Files:**
- Move: `orchestrator/drift.ts` → `orchestrator/drift/drift.ts`
- Move: `orchestrator/drift.test.ts` → `orchestrator/drift/drift.test.ts`
- Move: `orchestrator/drift-chain.ts` → `orchestrator/drift/drift-chain.ts`
- Move: `orchestrator/drift-chain.test.ts` → `orchestrator/drift/drift-chain.test.ts`
- Move: `orchestrator/drift-chain-state.ts` → `orchestrator/drift/drift-chain-state.ts`
- Move: `orchestrator/drift-chain-state.test.ts` → `orchestrator/drift/drift-chain-state.test.ts`
- Move: `orchestrator/drift-chain-integration.test.ts` → `orchestrator/drift/drift-chain-integration.test.ts`

- [ ] **Step 1: Create directory, move files, fix imports (same process as Task 6)**

```bash
mkdir -p src/engine/orchestrator/drift
```

- [ ] **Step 2: Update internal imports within drift files**

Drift files import from each other (e.g., `drift-chain.ts` imports from `./drift-chain-state.js`). These stay the same since they're in the same directory.

External imports change depth: `./events.js` → `../events.js`, etc.

- [ ] **Step 3: Update external consumers**

```bash
grep -r "from.*\/drift\|from.*drift-chain" src/engine/ --include="*.ts" -l
```

Update: `./drift.js` → `./drift/drift.js`, `./drift-chain.js` → `./drift/drift-chain.js`, etc.

- [ ] **Step 4: Delete old files, verify**

```bash
npm run test-ci
```

---

## Phase 3: DRY Fixes (parallelizable — non-overlapping files)

---

### Task 8: Extract shared explain utilities

**Files:**
- Modify: `src/engine/orchestrator/explain/routing.ts`
- Modify: `src/engine/orchestrator/explain/artifacts.ts`
- Modify: `src/engine/orchestrator/explain/sections.ts`

- [ ] **Step 1: Add shared helpers to `explain/types.ts`**

Add these utility functions (currently triplicated):

```typescript
export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(v => v.trim().length > 0))];
}
```

- [ ] **Step 2: Replace duplicates in routing.ts, artifacts.ts, sections.ts**

In each file, remove the local `stringValue`/`uniqueStrings` definitions and import from `./types.js`.

- [ ] **Step 3: Verify**

```bash
npm run test-ci
```

---

### Task 9: Fix spec/formatter.ts DRY (scope rendering duplication)

**Files:**
- Modify: `src/engine/spec/formatter.ts`
- Test: `src/engine/spec/formatter.test.ts`

- [ ] **Step 1: Identify the duplication**

`buildScopeLines()` (lines ~71-85) renders scope. `formatSingleTask()` (lines ~281-299) re-implements the same rendering inline.

- [ ] **Step 2: Make `formatSingleTask` call `buildScopeLines`**

Replace the inline scope rendering in `formatSingleTask` with:

```typescript
const scopeLines = buildScopeLines(task.scope);
if (scopeLines.length > 0) {
  lines.push('', ...scopeLines);
}
```

Ensure `buildScopeLines` is accessible (move above `formatSingleTask` if not already).

- [ ] **Step 3: Verify**

```bash
npx vitest run src/engine/spec/formatter.test.ts
npm run test-ci
```

---

### Task 10: Fix graph.ts O(n^2) import resolution

**Files:**
- Modify: `src/engine/codebase/graph.ts:36-49`
- Test: `src/engine/codebase/graph.test.ts`

- [ ] **Step 1: Read the current `resolveImport` function**

It iterates `pathSet` for each extension candidate, comparing resolved paths.

- [ ] **Step 2: Pre-build a resolution Map**

At the top of `buildGraph` (before the loop that calls `resolveImport`), add:

```typescript
import { resolve as pathResolve, dirname } from 'node:path';

// Pre-compute normalized paths for O(1) lookup
const resolvedPathMap = new Map<string, string>();
for (const p of pathSet) {
  resolvedPathMap.set(pathResolve(p), p);
  // Also add without extension for extensionless imports
  const withoutExt = p.replace(/\.[^.]+$/, '');
  resolvedPathMap.set(pathResolve(withoutExt), p);
}
```

- [ ] **Step 3: Replace `resolveImport` to use the Map**

```typescript
function resolveImport(importPath: string, fromFile: string, resolved: Map<string, string>): string | null {
  const dir = dirname(fromFile);
  const candidates = [
    pathResolve(dir, importPath),
    pathResolve(dir, importPath + '.ts'),
    pathResolve(dir, importPath + '.tsx'),
    pathResolve(dir, importPath + '/index.ts'),
  ];
  for (const candidate of candidates) {
    const match = resolved.get(candidate);
    if (match) return match;
  }
  return null;
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run src/engine/codebase/graph.test.ts
npm run test-ci
```

---

## Phase 4: Error Handling & Dead Code

---

### Task 11: Add boundary error handling to codebase/parse.ts

**Files:**
- Modify: `src/engine/codebase/parse.ts:105-106`
- Test: `src/engine/codebase/parse.test.ts`

- [ ] **Step 1: Read parse.ts to understand the context**

Lines 105-106: `statSync(absPath)` and `readFileSync(absPath)` in `parseFile` can throw on unreadable files.

- [ ] **Step 2: Wrap filesystem access in try/catch**

```typescript
export function parseFile(absPath: string): FileNode | null {
  await initParser();
  let content: string;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
  // ... rest of parsing
}
```

Return `null` on unreadable files (callers already handle null via the cache layer).

- [ ] **Step 3: Verify**

```bash
npx vitest run src/engine/codebase/parse.test.ts
npm run test-ci
```

---

### Task 12: Clean up dead code and naming issues

**Files:**
- Modify: `src/engine/orchestrator/approvals-store.ts` (already done in Task 2)
- Modify: `src/engine/handoff/renderers/shared.ts` (remove `taskNum`)
- Modify: `src/engine/spec/prompts/clarify.ts` (remove or mark `buildClarifyPrompt`)
- Modify: `src/engine/spec/brief-quality.ts` (rename `non_atomic_task`)

- [ ] **Step 1: Remove unused `taskNum` export from handoff/renderers/shared.ts**

Find and delete the `taskNum` function. Verify nothing imports it:
```bash
grep -r "taskNum" src/ --include="*.ts"
```

- [ ] **Step 2: Verify `buildClarifyPrompt` is truly unused**

```bash
grep -r "buildClarifyPrompt" src/ --include="*.ts" -l
```

If only test file imports it: delete both the function export and its test. If something does import it, leave it.

- [ ] **Step 3: Rename `non_atomic_task` to `missing_type_definitions`**

In `src/engine/spec/brief-quality.ts`:
- Replace the string literal `'non_atomic_task'` everywhere in the file
- Update the `BRIEF_QUALITY_ISSUE_CODES` Set
- Update the union type

Search for external consumers:
```bash
grep -r "non_atomic_task" src/ --include="*.ts"
```
Update all.

- [ ] **Step 4: Verify**

```bash
npm run test-ci
```

---

## Phase 5: Test Suite Fixes

---

### Task 13: Rewrite test files that mock internal modules

**Files:**
- Modify: `src/engine/ipc/spawn-server.test.ts`
- Modify: `src/engine/orchestrator/task-step.recovery.test.ts`
- Modify: `src/engine/orchestrator/task-step.test.ts`

- [ ] **Step 1: Fix spawn-server.test.ts**

Read the current test. It mocks `./lockfile.js`. The fix: control lockfile behavior by writing/not-writing actual lockfiles to a temp directory. The test already uses temp dirs — extend that pattern.

Replace `vi.mock('./lockfile.js', ...)` with real lockfile setup:
- Create a real lockfile with specific content to simulate "alive" status
- Delete the lockfile to simulate "not running" status
- Write a stale heartbeat to simulate "stale" status

- [ ] **Step 2: Fix task-step.recovery.test.ts**

It mocks `./escalation/escalation.js` to make `handleRetryAndEscalation` reject. Instead, inject a planner/implementer that causes escalation to fail naturally.

The orchestrator test factories (`testing/helpers/orchestrator-factories.ts`) already provide mock planners/implementers. Configure one to throw on `escalateHint` to trigger the recovery path naturally.

- [ ] **Step 3: Fix task-step.test.ts spy**

Remove `vi.spyOn(implementer, 'retry')` at line 793 and the corresponding `expect(retry).not.toHaveBeenCalled()`. The test already asserts the correct behavior through file content and event assertions.

- [ ] **Step 4: Verify all tests pass**

```bash
npm run test-ci
```

---

## Phase 6: Anti-Slop & Minor Fixes

---

### Task 14: Fix anti-slop patterns in prompts

**Files:**
- Modify: `src/engine/spec/prompts/escalation.ts`
- Modify: `src/engine/spec/prompts/plan.ts`
- Modify: `src/engine/spec/prompts/research.ts`
- Modify: `src/engine/spec/prompts/spec.ts`
- Modify: `src/engine/spec/prompts/review.ts`

- [ ] **Step 1: Search for the `  -  ` pattern**

```bash
grep -rn "  -  " src/engine/spec/prompts/ --include="*.ts"
```

- [ ] **Step 2: Replace all occurrences with ` -- `**

In each file, replace the `  -  ` (double-space-dash-double-space) separator with ` -- ` (space-double-dash-space), which is standard English em-dash representation.

- [ ] **Step 3: Verify**

```bash
npm run test-ci
```

---

### Task 15: Rename root `agent-sdk.ts` to disambiguate

**Files:**
- Rename: `src/engine/agent-sdk.ts` → `src/engine/agent-sdk-backend.ts`
- Rename: `src/engine/agent-sdk.test.ts` → `src/engine/agent-sdk-backend.test.ts`
- Modify: All files importing from `../agent-sdk.js` or `./agent-sdk.js`

- [ ] **Step 1: Find all consumers**

```bash
grep -rn "from.*engine/agent-sdk\|from.*\./agent-sdk\|from.*\.\./agent-sdk" src/ --include="*.ts" | grep -v "implementers/agent-sdk\|planners/agent-sdk"
```

- [ ] **Step 2: Copy file to new name, update internal imports in the file**

Create `src/engine/agent-sdk-backend.ts` with contents of `src/engine/agent-sdk.ts`.
Create `src/engine/agent-sdk-backend.test.ts` with contents of `src/engine/agent-sdk.test.ts`.

- [ ] **Step 3: Update all consumer imports**

Change `./agent-sdk.js` → `./agent-sdk-backend.js` (or equivalent relative path) in all consuming files.

- [ ] **Step 4: Delete old files**

Remove `src/engine/agent-sdk.ts` and `src/engine/agent-sdk.test.ts`.

- [ ] **Step 5: Verify**

```bash
npm run test-ci
```

---

## Execution Order Summary

| Order | Task | Depends on | Can parallel with |
|---|---|---|---|
| 1 | Task 1: Hook system bugs | — | — |
| 2 | Task 2: Remove approvals duplicate | — | Task 1 |
| 3 | Task 3: Extract dispatch-stream | — | Tasks 1-2 |
| 4 | Task 4: Planners DRY | Task 3 | — |
| 5 | Task 5: Fix upward dependency | — | Tasks 3-4 |
| 6 | Task 6: Move explain/ | Tasks 1-5 | Task 7 |
| 7 | Task 7: Move drift/ | Tasks 1-5 | Task 6 |
| 8 | Task 8: Explain utilities DRY | Task 6 | Tasks 9-10 |
| 9 | Task 9: Formatter DRY | — | Tasks 8, 10 |
| 10 | Task 10: Graph performance | — | Tasks 8, 9 |
| 11 | Task 11: Parse error handling | — | Tasks 8-10 |
| 12 | Task 12: Dead code cleanup | Task 2 | Tasks 11, 13 |
| 13 | Task 13: Test rewrites | Tasks 1-5 | Tasks 11-12 |
| 14 | Task 14: Anti-slop prompts | — | Tasks 13, 15 |
| 15 | Task 15: Rename agent-sdk | — | Task 14 |

**Parallelization opportunities:**
- Tasks 1 + 2 (independent)
- Tasks 6 + 7 (independent directory moves)
- Tasks 8 + 9 + 10 (non-overlapping files)
- Tasks 11 + 12 + 13 (non-overlapping files)
- Tasks 14 + 15 (non-overlapping files)

---

## Final Verification

After ALL tasks complete:

```bash
npm run test-ci
```

Then verify architectural invariants:

```bash
# Zero React imports in engine
grep -r "from.*react\|from.*ink" src/engine/ --include="*.ts" | grep -v "\.test\."

# Zero orchestrator imports in implementers
grep -r "from.*orchestrator" src/engine/implementers/ --include="*.ts"

# Zero barrel files
find src -name 'index.ts'

# All imports use .js extension
grep -rn "from '\.\." src/engine/ --include="*.ts" | grep -v "\.js'" | head -20
```

All should return 0 results (or the expected sanctioned exceptions).

---

## Phase 7: CRITICAL — Break React Dependency Chain (MUST execute BEFORE Phase 1)

> **IMPORTANT:** This task must execute FIRST — before Tasks 1-15. It resolves the project's hardest architectural invariant violation.

---

### Task 16: Break engine → React transitive dependency via stores

**Priority:** CRITICAL — the single hardest invariant violation in the project.

**Problem:** Engine files import from `stores/` which imports `create-store.ts` which imports `react`. This breaks "Zero engine → React imports."

**Offending imports:**
- `src/engine/orchestrator/task-loop.ts:23` — `import { modelCacheStore } from '../../stores/discovery/model-cache.js'`
- `src/engine/orchestrator/run/phases.ts:22` — `import { modelCacheStore } from '../../../stores/discovery/model-cache.js'`
- `src/engine/orchestrator/planning/run.ts:9` — `import { attachmentsStore } from '../../../stores/workflow/attachments.js'`
- `src/engine/detection/adapter.ts:2-3` — imports `detectionStore` and `modelCacheStore`
- `src/engine/events/sinks/tui.ts:1` — `import * as actions from '../../../stores/workflow/actions.js'`

**Files:**
- Create: `src/features/workflow/tui-sink.ts` (moved from engine)
- Modify: `src/engine/orchestrator/task-loop.ts`
- Modify: `src/engine/orchestrator/run/phases.ts`
- Modify: `src/engine/orchestrator/planning/run.ts`
- Modify: `src/engine/detection/adapter.ts`
- Delete: `src/engine/events/sinks/tui.ts`
- Modify: wherever `createTuiSink` is called (to import from features layer)

- [ ] **Step 1: Find all engine→stores imports**

```bash
grep -rn "from.*stores/" src/engine/ --include="*.ts" | grep -v "\.test\."
```

Document every import.

- [ ] **Step 2: Move `events/sinks/tui.ts` to features layer**

The TUI sink belongs in `src/features/workflow/` because it bridges engine events to React stores.

Create `src/features/workflow/tui-sink.ts`:
```typescript
import * as actions from '../../stores/workflow/actions.js';
import type { EventSink } from '../../engine/events/types.js';

export function createTuiSink(): EventSink {
  return actions.addEvent;
}
```

Delete `src/engine/events/sinks/tui.ts`.

- [ ] **Step 3: Update the TUI sink consumer**

Find where `createTuiSink` is imported from engine and change the import path to features:
```bash
grep -rn "createTuiSink\|tui\.js\|sinks/tui" src/ --include="*.ts"
```

Update to import from `../../features/workflow/tui-sink.js` (adjust path per consumer location).

- [ ] **Step 4: Refactor store access in engine to use dependency injection**

For each engine file that imports stores, replace the direct import with a parameter:

**`orchestrator/task-loop.ts`** — The `modelCacheStore` is used for cached model lookups. Instead of importing the store, accept a `getModelCache: () => ModelCache` callback in the function parameters.

**`orchestrator/run/phases.ts`** — Same pattern: accept `getModelCache` as parameter.

**`orchestrator/planning/run.ts`** — `attachmentsStore` is read for pending attachments. Accept `getAttachments: () => Attachment[]` callback.

**`detection/adapter.ts`** — Bridges detection results to `detectionStore` and `modelCacheStore`. This entire file is an adapter between engine and stores — it should live outside engine. Move to `src/stores/discovery/detection-adapter.ts` or accept store-write callbacks.

- [ ] **Step 5: Wire the callbacks at the composition point**

In `src/cli/` or `src/features/workflow/` (wherever orchestrator is bootstrapped), pass the store accessors:

```typescript
const workflow = runWorkflow({
  // ...existing config...
  getModelCache: () => modelCacheStore.get(),
  getAttachments: () => attachmentsStore.get().pending,
});
```

- [ ] **Step 6: Verify zero store imports in engine**

```bash
grep -rn "from.*stores/" src/engine/ --include="*.ts" | grep -v "\.test\."
```
Expected: 0 results

- [ ] **Step 7: Verify zero React imports in engine**

```bash
grep -rn "from.*react\|from.*ink" src/engine/ --include="*.ts" | grep -v "\.test\."
```
Expected: 0 results

- [ ] **Step 8: Full verification**

```bash
npm run test-ci
```

---

## Phase 8: Remaining HIGH-Severity SRP Splits

---

### Task 17: Split `recovery.ts` (1106 LOC, 3 concerns)

**Files:**
- Create: `src/engine/orchestrator/recovery-builders.ts` — issue construction (8 `buildXxxRecoveryIssue` functions)
- Create: `src/engine/orchestrator/recovery-actions.ts` — `applyRecoveryAction` + 5 strategy functions
- Modify: `src/engine/orchestrator/recovery.ts` — keep only the top-level `buildRecoveryPlan` compositor; move builders and actions out
- Modify: Test files that import from recovery.ts

- [ ] **Step 1: Read `recovery.ts` fully and identify the three concern boundaries**

Three concerns:
1. Issue builders (functions named `buildXxxRecoveryIssue`) → `recovery-builders.ts`
2. Action appliers (`applyRecoveryAction` + strategies) → `recovery-actions.ts`
3. Utilities (`looksLikeFilePath`, `uniqueFiles`, `summarizeText`, `uniqueTaskIds`) → inline into above or extract to shared utility

- [ ] **Step 2: Create `recovery-builders.ts`**

Move all `buildXxxRecoveryIssue` functions. Update imports.

- [ ] **Step 3: Create `recovery-actions.ts`**

Move `applyRecoveryAction` and its strategy functions. Update imports.

- [ ] **Step 4: Slim down `recovery.ts` to compositor-only**

Keep the orchestrating function that calls builders and actions. Import from the new files.

- [ ] **Step 5: Extract `uniqueTaskIds` to shared utility**

This function is duplicated in `user-edit-conflicts.ts` too (DRY M-2). Extract to `src/utils/collections.ts`:
```typescript
export function uniqueIds<T extends string>(ids: T[]): T[] {
  return [...new Set(ids)].sort();
}
```
Update both consumers.

- [ ] **Step 6: Verify**

```bash
npm run test-ci
```

---

### Task 18: Split `review-packet.ts` (989 LOC, 3+ concerns)

**Files:**
- Create: `src/engine/orchestrator/review-packet-build.ts` — JSON packet construction
- Create: `src/engine/orchestrator/review-packet-render.ts` — markdown rendering
- Modify: `src/engine/orchestrator/review-packet.ts` — keep entry point, delegate to build + render

- [ ] **Step 1: Read `review-packet.ts` fully, identify boundaries**

- [ ] **Step 2: Extract `review-packet-build.ts`** — all JSON/object construction logic
- [ ] **Step 3: Extract `review-packet-render.ts`** — all markdown/string rendering
- [ ] **Step 4: Slim `review-packet.ts` to orchestrator-only** — reads state, calls build, calls render, writes file
- [ ] **Step 5: Verify**

```bash
npm run test-ci
```

---

## Phase 9: Remaining Medium DRY + SRP Fixes

---

### Task 19: Move `formatMessagesForCli` out of orchestrator (M-16)

**Files:**
- Move function from: `src/engine/orchestrator/transcript-rebuild.ts`
- Move function to: `src/engine/streaming/format-messages.ts` (new file, or into existing streaming module)
- Modify: `src/engine/planners/base.ts:15` — update import path

- [ ] **Step 1: Check what `transcript-rebuild.ts` exports and who uses what**

```bash
grep -rn "from.*transcript-rebuild" src/ --include="*.ts"
```

- [ ] **Step 2: If `formatMessagesForCli` is the only export used by planners, extract it**

Create `src/engine/streaming/format-messages.ts` with the function.
Update `planners/base.ts` to import from `../streaming/format-messages.js`.
If orchestrator also uses it, update that import too.

- [ ] **Step 3: Verify no planners→orchestrator imports remain**

```bash
grep -rn "from.*orchestrator" src/engine/planners/ --include="*.ts"
```
Expected: 0 results

- [ ] **Step 4: Verify**

```bash
npm run test-ci
```

---

### Task 20: Create remaining orchestrator subdirectories (HIGH-6 completion)

**Files:**
- Move: `orchestrator/approval.ts`, `orchestrator/tiered-approval.ts`, `orchestrator/action-classifier.ts` → `orchestrator/approval/`
- Move: `orchestrator/budget.ts`, `orchestrator/cost-prediction.ts`, `orchestrator/estimate.ts` → `orchestrator/budget/`
- Move: `orchestrator/evidence.ts`, `orchestrator/review-packet.ts` (or its split files) → `orchestrator/evidence/`
- Move corresponding `.test.ts` files

- [ ] **Step 1: Create directories**

```bash
mkdir -p src/engine/orchestrator/approval
mkdir -p src/engine/orchestrator/budget
mkdir -p src/engine/orchestrator/evidence
```

- [ ] **Step 2: Move files, fix imports (same process as Tasks 6-7)**

For each group: move files, update internal relative imports (add `../` prefix for cross-directory imports), update external consumers.

- [ ] **Step 3: Verify**

```bash
npm run test-ci
```

---

### Task 21: Medium DRY batch (M-4, M-5, M-8, M-9)

**Files:**
- Modify: `src/engine/snapshots/store.ts` (M-4: extract shared hash logic)
- Modify: `src/engine/streaming/output-parsers.ts` (M-5: remove re-export, align types)
- Create: `src/lib/fs-state.ts` or add to existing `src/lib/fs.ts` (M-8: readJsonState/writeJsonState)
- Modify: `src/engine/orchestrator/planning/rewind.ts` (M-9: extract shared spine)

- [ ] **Step 1: M-4 — Extract `hashAndStorePaths` in snapshots/store.ts**

Read `snapshots/store.ts:227-325`. The baseline and delta branches share 80% logic. Extract:
```typescript
async function hashAndStorePaths(
  trackedPaths: string[],
  filesDir: string,
  shouldSkip?: (path: string, hash: string) => boolean,
): Promise<{ fileHashes: Map<string, string>; fileEntries: FileEntry[] }>
```
Both branches call this helper with different `shouldSkip` predicates.

- [ ] **Step 2: M-5 — Remove re-export barrel in output-parsers.ts**

Remove line 8: `export { accumulateUsage } from './token-utils.js'`
Find consumers that import `accumulateUsage` from `output-parsers.js`:
```bash
grep -rn "accumulateUsage.*output-parsers" src/ --include="*.ts"
```
Update them to import directly from `./token-utils.js`.

Also: make `parseStreamLine` return `ParsedLine` directly instead of `StreamParseResult`, and remove `StreamParseResult` type and `wrapStreamParser`.

- [ ] **Step 3: M-8 — Create `readJsonState` / `writeJsonState` utilities**

Add to `src/lib/fs.ts` (or create `src/lib/fs-state.ts`):
```typescript
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { ZodSchema } from 'zod';
import { ensureSecureDir, SECURE_FILE_MODE } from './fs.js';

export function readJsonState<T>(path: string, schema?: ZodSchema<T>): T | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return schema ? schema.parse(raw) : raw as T;
  } catch {
    return null;
  }
}

export function writeJsonState(path: string, data: unknown): void {
  ensureSecureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: SECURE_FILE_MODE });
}
```

Then refactor the 5+ call sites in orchestrator that repeat this pattern.

- [ ] **Step 4: M-9 — Extract shared rewind spine**

In `orchestrator/planning/rewind.ts`, extract common flow of `handleRewindSpec` and `handleRewindPlan` into a shared `handleRewind(target, artifactFile, regenerateMode)` function.

- [ ] **Step 5: Verify**

```bash
npm run test-ci
```

---

### Task 22: Medium SRP batch (M-10, M-11, M-12)

**Files:**
- Modify: `src/engine/spec/formatter.ts` (M-10: split prompt-formatter + task-serializer)
- Modify: `src/engine/orchestrator/task-step.ts` (M-11: extract evidence persistence)
- Modify: `src/engine/mcp/tool-handler.ts` (M-12: extract tool-operations)

- [ ] **Step 1: M-10 — Split spec/formatter.ts**

Create `src/engine/spec/prompt-formatter.ts` (formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE).
Create `src/engine/spec/task-serializer.ts` (formatTasks, formatSingleTask, buildScopeLines, buildTaskSections).
Slim `formatter.ts` to re-export or delete.

Also move `SYSTEM_PREAMBLE` to `src/engine/spec/prompts/system.ts` (M-15).

- [ ] **Step 2: M-11 — Extract evidence persistence from task-step.ts**

Move `persistTaskEvidence`, `persistRejectionEvidence`, `persistApprovalEvidence` (and their shared boilerplate) into `src/engine/orchestrator/evidence-persistence.ts`.

- [ ] **Step 3: M-12 — Extract tool operations from mcp/tool-handler.ts**

Move the five `handle*` functions and `readCheckedLedger` into `src/engine/mcp/tool-operations.ts`.
Keep `tool-handler.ts` as thin dispatch.

- [ ] **Step 4: Verify**

```bash
npm run test-ci
```

---

### Task 23: Architecture + Type Safety fixes (M-13, M-14, M-17)

**Files:**
- Modify: `src/engine/events/types.ts` (M-13: remove orchestrator type imports)
- Modify: `src/engine/orchestrator/planning/shared.ts` (M-14: re-export public API through run.ts)
- Modify: `src/engine/orchestrator/planning/speckit.ts` (M-17: extend config schema)

- [ ] **Step 1: M-13 — Break events/types → orchestrator cycle**

Move shared types (`ApprovalTier`, `UserEditConflict`, `UserEditConflictAction`, `CurrentCodeContextMode`, `TaskContextFit`, `TaskReviewRequest`) from orchestrator files into `src/core/schemas/` or a dedicated `src/core/types/workflow-events.ts`.

Update `events/types.ts` to import from `core/` instead of `orchestrator/`.

- [ ] **Step 2: M-14 — Re-export public API through planning/run.ts**

`runBriefQualityGate` from `planning/shared.ts` is used externally. Add re-export in `planning/run.ts`:
```typescript
export { runBriefQualityGate } from './shared.js';
```
Update external consumers to import from `./planning/run.js` instead of `./planning/shared.js`.

- [ ] **Step 3: M-17 — Extend config schema for speckit**

Add `speckit?: { minCoverage?: number }` to the workflow config Zod schema in `src/core/schemas/config.ts`.
Remove the `as` cast in `speckit.ts:126`.

- [ ] **Step 4: Verify**

```bash
npm run test-ci
```

---

### Task 24: Performance + YAGNI cleanup

**Files:**
- Modify: `src/engine/providers/anthropic/stream.ts` (M-23: async readFile)
- Modify: `src/engine/providers/openai-stream.ts` (M-23: async readFile)
- Modify: `src/engine/snapshots/checkpoint-summary.ts` (M-28: extract safety blob)
- Modify: `src/engine/codebase/repomap.ts` or types (YAGNI: remove unused `include`)
- Modify: `src/engine/codebase/cache.ts` (YAGNI: remove unused index)
- Modify: `src/engine/orchestrator/planning/mode-advisor.ts` (YAGNI: remove deprecated `shouldAdvise`)

- [ ] **Step 1: M-23 — Replace readFileSync with async readFile**

In `anthropic/stream.ts` and `openai-stream.ts`, the `attachImagesToLastUserMessage` function uses `readFileSync`. Make it async:
```typescript
import { readFile } from 'node:fs/promises';

async function attachImagesToLastUserMessage(...) {
  // Replace readFileSync(path) with await readFile(path)
}
```
Update callers to `await` the result.

- [ ] **Step 2: M-28 — Extract CHECKPOINT_RESTORE_SAFETY to presentation**

Move the `CHECKPOINT_RESTORE_SAFETY` constant out of the per-summary object into a standalone export used only by the CLI formatter.

- [ ] **Step 3: YAGNI cleanup**

- Remove `include?: string[]` from repomap options type
- Remove `CREATE INDEX IF NOT EXISTS idx_mtime ON files (mtime_ms)` from cache.ts
- Remove `shouldAdvise` field from `AdvisorResult` type in mode-advisor.ts and all return sites

- [ ] **Step 4: Verify**

```bash
npm run test-ci
```

---

### Task 25: Remaining test rewrites

**Files:**
- Modify: `src/engine/handoff/write.test.ts` — remove `vi.mock('./render.js')` for mode tests
- Modify: `src/engine/orchestrator/task-loop.recovery.test.ts` — remove `vi.mock('../../lib/git.js')`
- Modify: `src/engine/orchestrator/task-loop.test.ts` — simplify redundant `toHaveBeenCalledTimes`

- [ ] **Step 1: Fix handoff/write.test.ts**

The mode-resolution tests spy on `renderHandoffWithCustom` arguments. Rewrite to assert rendered output content instead. Keep the mock only for path-traversal security tests (injecting `../escape.md`).

- [ ] **Step 2: Fix task-loop.recovery.test.ts**

Replace `vi.mock('../../lib/git.js')` with real git repo setup (the sibling `task-loop.test.ts` already does this with `createTestGitRepo`).

- [ ] **Step 3: Simplify task-loop.test.ts**

Remove redundant `toHaveBeenCalledTimes` assertions where `currentTaskIndex` or task status already proves the same behavior.

- [ ] **Step 4: Verify**

```bash
npm run test-ci
```

---

## UPDATED Execution Order (Full 25 Tasks)

| Order | Task | Depends on | Can parallel with |
|---|---|---|---|
| **0** | **Task 16: Break React deps** | — | — |
| 1 | Task 1: Hook system bugs | Task 16 | Task 2 |
| 2 | Task 2: Remove approvals dup | Task 16 | Task 1 |
| 3 | Task 3: Extract dispatch-stream | Tasks 1-2 | — |
| 4 | Task 4: Planners DRY | Task 3 | Task 5 |
| 5 | Task 5: Fix upward dep (implementers) | Task 3 | Task 4 |
| 6 | Task 19: Move formatMessagesForCli | Task 5 | — |
| 7 | Task 6: Move explain/ | Task 6 | Task 7, Task 20 |
| 8 | Task 7: Move drift/ | Task 6 | Task 6, Task 20 |
| 9 | Task 20: Create approval/budget/evidence/ dirs | Task 6 | Tasks 6-7 |
| 10 | Task 17: Split recovery.ts | Task 20 | Task 18 |
| 11 | Task 18: Split review-packet.ts | Task 20 | Task 17 |
| 12 | Task 8: Explain utilities DRY | Task 6 (move) | Tasks 9-10 |
| 13 | Task 9: Formatter DRY | — | Tasks 8, 10, 22 |
| 14 | Task 10: Graph performance | — | Tasks 8, 9 |
| 15 | Task 21: Medium DRY batch | Tasks 4, 17 | Task 22 |
| 16 | Task 22: Medium SRP batch | Task 9 | Task 21 |
| 17 | Task 23: Architecture + types | Task 16, Tasks 6-7 | Task 24 |
| 18 | Task 11: Parse error handling | — | Tasks 21-24 |
| 19 | Task 12: Dead code cleanup | Task 2 | Tasks 11, 13 |
| 20 | Task 24: Performance + YAGNI | — | Tasks 11-12 |
| 21 | Task 13: Test rewrites (original 3) | Tasks 1-5 | Task 25 |
| 22 | Task 25: Test rewrites (remaining) | Tasks 17-18 | Task 13 |
| 23 | Task 14: Anti-slop prompts | — | Task 15 |
| 24 | Task 15: Rename agent-sdk | — | Task 14 |

---

## Reference Documents

Before implementing, the executing agent MUST read:
- `CLAUDE.md` — project conventions (NEVER COMMIT, zero classes, ESM, etc.)
- `docs/STRUCTURE.md` — file placement rules
- `docs/PRINCIPLES.md` — architectural principles
- `docs/INVARIANTS.md` — enforced invariants (grep gates)
- `docs/audits/engine-audit-2026-04-30.md` — full audit findings with file:line references

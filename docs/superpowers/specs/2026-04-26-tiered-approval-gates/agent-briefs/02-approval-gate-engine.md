# 02 — Approval Gate Engine

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Agent: Approval Gate Engine implementer
Brief: 02 of 06 (Tiered Approval Gates spec)

## Intent

Add orchestrator-side gate logic that classifies each implementer action, consults the sticky approvals store, invokes a TUI callback when a prompt is required, and returns an allow/deny decision. Emit structured engine events. Compose with (not replace) the existing `runPreHooks` pipeline.

## Scope

**In bounds:**
- `src/engine/orchestrator/tiered-approval.ts` (new file)
- `src/engine/orchestrator/tiered-approval.test.ts` (new file)
- `src/engine/orchestrator/types.ts` — add `onTieredApproval` to `OrchestratorCallbacks`
- `src/engine/orchestrator/task-step.ts` — add `gateAction` call site (see Implementation Plan §5)
- `src/engine/events/types.ts` — add four new event variants
- `src/core/paths.ts` — add `approvalsFile` path helper

**Out of bounds:**
- Do not modify `src/engine/orchestrator/approval.ts` (document-level loop).
- Do not modify `src/engine/hooks/run-pre-hook.ts`, `dispatch.ts`, or `registry.ts`.
- Brief 03 owns config schema; read the types but do not edit `src/core/schemas/config.ts` here.
- Brief 06 owns evidence ledger mutation; emit the event but do not write to `evidence.json` here.
- Brief 04 owns the TUI prompt component; this brief defines only the callback interface.
- Do not gate `api`/`shell`/`agent-sdk` per-action in v1; that requires `Implementer` interface changes deferred to v2 (see ADR-012).

## Code Context

Read before implementing:

- `src/engine/orchestrator/action-classifier.ts` (from brief 01) — `classifyAction`, `ActionClass`, `ApprovalTier`, `ClassifyInput`
- `src/engine/orchestrator/types.ts` — `OrchestratorCallbacks`, `WorkflowContext`
- `src/engine/events/types.ts` — event union shape, `publishEvent` pattern
- `src/engine/hooks/run-pre-hook.ts` — `PreHookResult`, `runPreHooks` — gate runs before this
- `src/core/paths.ts` — `APPROVALS_FILE`, `diptychDir`, `getDiptychPath`
- `src/core/schemas/config.ts` — to read `ApprovalConfig` (from brief 03, optional field)
- `src/lib/fs.ts` — `ensureSecureDir`, `SECURE_FILE_MODE`

## Implementation Plan

### 1. Add path helper to `src/core/paths.ts`

```ts
export const approvalsFile = (projectDir: string): string =>
  join(projectDir, DIPTYCH_DIR, APPROVALS_FILE);
```

### 2. Add engine events to `src/engine/events/types.ts`

```ts
| { type: 'approval_prompted'; ts: number; phase: Phase; tier: ApprovalTier; actionClass: ActionClass; taskId?: TaskId }
| { type: 'approval_granted'; ts: number; phase: Phase; tier: ApprovalTier; actionClass: ActionClass; taskId?: TaskId; scope: 'once' | 'session' | 'always' }
| { type: 'approval_rejected'; ts: number; phase: Phase; tier: ApprovalTier; actionClass: ActionClass; taskId?: TaskId; reason: string }
| { type: 'approval_sticky_recorded'; ts: number; phase: Phase; pattern: string; scope: 'session' | 'always'; actionClass: ActionClass }
```

Import `ApprovalTier` and `ActionClass` from `'../orchestrator/action-classifier.js'` in the events types file.

### 3. Add `onTieredApproval` to `OrchestratorCallbacks` in `src/engine/orchestrator/types.ts`

```ts
onTieredApproval?: ((request: TieredApprovalRequest) => Promise<TieredApprovalResponse>) | undefined;
```

Where `TieredApprovalRequest` and `TieredApprovalResponse` are exported from `tiered-approval.ts`:

```ts
export type TieredApprovalRequest = {
  tier: ApprovalTier;
  actionClass: ActionClass;
  actionDescription: string;
  taskId?: TaskId;
  phase: Phase;
};

export type TieredApprovalResponse =
  | { decision: 'allow'; scope: 'once' | 'session' | 'always' }
  | { decision: 'deny'; reason: string }
  | { decision: 'confirm'; phrase: string; reason: string };  // confirm tier only
```

### 4. Implement `gateAction` in `src/engine/orchestrator/tiered-approval.ts`

```ts
export type GateActionInput = {
  actionDescription: string;
  task: Task;
  dependsOnFiles: string[];
  projectDir: string;
  sessionId: string;
  phase: Phase;
  taskId?: TaskId;
  bus: EventBus;
  callbacks: OrchestratorCallbacks;
  config: Config;
};

export type GateDecision = { allow: boolean; reason?: string };

export async function gateAction(input: GateActionInput): Promise<GateDecision>
```

Implementation steps inside `gateAction`:

1. If `config.approval?.enabled === false`, return `{ allow: true }` immediately.
2. Classify action using `classifyAction` with tier overrides from `config.approval?.tiers`.
3. If tier is `auto`, return `{ allow: true }` (no event emitted for auto).
4. Emit `approval_prompted` event.
5. **Sticky tier:**
   a. Load `.diptych/approvals.json`. If file is absent, treat as empty grants list.
   b. Check for a matching `always` grant for the action class.
   c. If found, emit `approval_granted` with `scope: 'always'`, return `{ allow: true }`.
   d. Check for a matching `session` grant where `grant.sessionId === sessionId`.
   e. If found, emit `approval_granted` with `scope: 'session'`, return `{ allow: true }`.
   f. If no grant found and `onTieredApproval` is absent or headless: return `{ allow: false, reason: 'APPROVAL_REQUIRED' }`.
   g. Call `callbacks.onTieredApproval(request)`.
   h. On `decision: 'deny'`: emit `approval_rejected`, return `{ allow: false, reason }`.
   i. On `decision: 'allow'` with `scope: 'session'` or `'always'`: persist grant to `.diptych/approvals.json`, emit `approval_sticky_recorded`, emit `approval_granted`, return `{ allow: true }`.
   j. On `decision: 'allow'` with `scope: 'once'`: emit `approval_granted` (scope: once), return `{ allow: true }` (no persistence).
6. **Confirm tier:**
   a. If `onTieredApproval` is absent or headless: return `{ allow: false, reason: 'APPROVAL_REQUIRED' }`.
   b. Call `callbacks.onTieredApproval(request)`.
   c. On `decision: 'confirm'`: validate that `phrase === 'I confirm'` and `reason` is non-empty. If invalid phrase, return `{ allow: false, reason: 'invalid_confirm_phrase' }`.
   d. If valid: emit `approval_granted` (scope: once), return `{ allow: true }`.
   e. On `decision: 'deny'`: emit `approval_rejected`, return `{ allow: false, reason }`.

### 5. Wire `gateAction` into `src/engine/orchestrator/task-step.ts`

Per ADR-012, v1 gates at the **task level** for all runner kinds (the implementer runs inside a subprocess for `cli`/`agent` and action-level interception is not available without OS sandboxing).

**Exact call site:** in `runSingleTask`, after `publishTaskStart(...)` and before the `withContinuationLoop` block (around line 164 in the current file):

```ts
// Gate the task before implementation begins
const gateResult = await gateAction({
  actionDescription: `${task.action} ${task.file}`,
  task,
  dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
  projectDir,
  sessionId,
  phase: state.phase,
  taskId: task.id,
  bus: wctx.bus,
  callbacks,
  config,
});
if (!gateResult.allow) {
  publishError(wctx.bus, state.phase, `Task blocked by approval gate: ${gateResult.reason ?? 'denied'}`);
  // Brief 06 wires rejection evidence from the approval_rejected event; no direct call needed here.
  return state;
}
```

Add a helper `resolveDependsOnFiles(tasks: Task[], task: Task): string[]` that returns the `file` field for each task in `task.dependsOn`. This is a pure utility; define it at the top of `task-step.ts`.

**Grant persistence** (helper `upsertApprovalGrant`):

```ts
function upsertApprovalGrant(
  projectDir: string,
  grant: ApprovalGrant,
): void
```

Reads `.diptych/approvals.json` (tolerate absence), upserts by `(pattern, actionClass, scope)`, writes back with `ensureSecureDir` + `SECURE_FILE_MODE`. Reject-on-duplicate: if a `session` grant exists for the same pattern+class, replace it. If an `always` grant exists, leave it and skip the session grant.

**Headless detection:**

```ts
function isHeadless(config: Config): boolean {
  return config.approval?.headless === true || !process.stdout.isTTY;
}
```

## Validation

### Tests (`src/engine/orchestrator/tiered-approval.test.ts`)

Cover at minimum:

- `approval.enabled: false` → allow unconditionally
- auto-tier action → allow, no events emitted
- sticky-tier, no existing grant, no callback → deny with `APPROVAL_REQUIRED`
- sticky-tier, `always` grant exists in store → allow without callback
- sticky-tier, `session` grant for current sessionId → allow without callback
- sticky-tier, `session` grant for different sessionId → treat as miss, invoke callback
- sticky-tier, callback returns `allow scope:once` → allow, no persistence
- sticky-tier, callback returns `allow scope:session` → allow, grant persisted, `approval_sticky_recorded` emitted
- sticky-tier, callback returns `deny reason:'wrong dir'` → deny, `approval_rejected` emitted with reason
- confirm-tier, headless → deny with `APPROVAL_REQUIRED`
- confirm-tier, valid phrase + reason → allow, `approval_granted` emitted
- confirm-tier, wrong phrase → deny with `invalid_confirm_phrase`
- confirm-tier, callback returns `deny` → deny, `approval_rejected` emitted
- tier override in config: `write_out_of_scope` → `confirm`
- grant persistence: upsert replaces session grant, leaves always grant intact

Use an in-memory fake for `onTieredApproval` callback. Write approvals.json to a `tmp` dir fixture.

## Constraints

- No imports from `ink`, `react`, or any `src/features/` / `src/components/` path.
- `gateAction` is async; do not make it synchronous.
- `upsertApprovalGrant` is synchronous (uses `readFileSync` / `writeFileSync`).
- Emit events before returning to ensure the event log is complete even on deny paths.
- Never catch errors from `callbacks.onTieredApproval` — let them propagate so the orchestrator can handle aborts.

## Escalation

If `process.stdout.isTTY` is unavailable in the test environment, use `config.approval?.headless` as the sole headless signal.

## Evidence Requirements

- New file: `src/engine/orchestrator/tiered-approval.ts`
- New file: `src/engine/orchestrator/tiered-approval.test.ts`
- Modified: `src/engine/orchestrator/types.ts`
- Modified: `src/engine/events/types.ts`
- Modified: `src/core/paths.ts`
- All tests pass: `npm test -- src/engine/orchestrator/tiered-approval.test.ts`
- Typecheck clean: `npm run typecheck`

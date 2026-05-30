# B06 — Orchestrator parameter objects (`WorkflowContext`)

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Collapse the dominant audit category — wide positional parameter lists in the
orchestrator — by converting a fixed set of functions to options/context objects, and
by extracting the duplicated plan→briefs approval tail in `planning/rewind.ts` into one
helper. The reusable context types **already exist** (`WorkflowContext`, `SessionRef`,
`BusContext`, `PlannerCallbacksContext`, `InstallQueueHandlerOpts`); this brief **reuses
and threads** them, introduces only three genuinely-new small types
(`WorkflowPersistenceContext`, `QueueHandlerContext`, `TierStepInput`), and updates every
call site so the tree typechecks. No behavior changes — pure signature/shape refactor
(the one exception: the redundant `taskId` parameter of `Validator.runValidation` is
derived from `task.id`, which is behavior-preserving because every caller already passes
`task.id`).

## Wave / ordering

- **Wave:** 4. **Runs after:** B01 (formatting sweep — every file is already reflowed),
  B02 (type-safety/exhaustiveness gate set), B03 (schema/enum single-sourcing). Reason
  (from the coordinator): this is the dominant category; signature churn must settle in
  Wave 4 before B10's SRP file splits move the same code. Build on B01–B03's edits; never
  revert them.
- **Decisions that bind this brief:** **none.** No D1–D13 governs B06's content (the
  "B01–B03" in the wave row is ordering, not a decision). Do not invent one.

## File ownership

Files this brief **edits** (all under `src/engine/orchestrator/` unless noted):

- `types.ts` — add `WorkflowPersistenceContext` type (new).
- `clarifications.ts` — `collectAndPersistClarifications` → options obj (PD-01).
- `queue.ts` — `createQueueHandler` (PD-02), `createClearQueueHandler` + new
  `QueueHandlerContext` (PD-03).
- `native-injection.ts` — `dispatchNativeInjection` → options obj (PD-04).
- `state-ops.ts` — `addUsageAndSave` first param → `WorkflowPersistenceContext` (PD-05).
  **Only `addUsageAndSave`.** `transitionAndSave`/`mergePersistedMessageQueue` are out of
  scope (see Out of scope).
- `escalation/validate-and-commit.ts` — `validateAndCommit` → options obj (PD-06).
  **Keep the `preApprovedChangedFiles === undefined` branch** — its deletion is DC-02,
  owned by B14. Do not delete it.
- `run/init.ts` — fold `initializeWorkflow`'s 5 trailing positionals into the options
  shape (PD-07).
- `run/phases.ts` — `applyPostPlanDrain` → `{ ctx, state, setTrackedState }` (PD-08).
- `planning/shared.ts` — `runBriefQualityGate` + `handlePlanningFailure` → options objs
  (PD-09). **Param shapes only.** B10 later splits this file into 3 modules; do not split
  it here.
- `planning/rewind.ts` — fold `handleRewindSpec`/`handleRewindPlan` extras into the
  options object (PD-10) **and** extract the shared plan→briefs tail into
  `finishPlanAndBriefsApproval(...)` (DRY-04).
- `escalation/run-escalation-tier.ts` — `runEscalationTier` + the 3 tier fns → one
  `TierStepInput` (new) (PD-11).
- `validation.ts` — `Validator.runValidation` → options obj; derive `taskId` from
  `task.id` (PD-12). **Do NOT remove `findAffectedTestFile` from the interface** — that
  is OE-02, owned by B16.
- `evidence/persistence.ts` — `persist*Evidence` family → options objs (PD-13).
- `approval/staged-project.ts` — `promoteStagedChanges` → options obj naming the two dir
  roles (PD-14).
- `transcript-rebuild.ts` — `compactResumeTranscript` → forward an options object (PD-26).
- `events.ts` — `publishRetry`, `publishBudgetWarning`, `publishBudgetPaused`,
  `publishBudgetExceeded` → options objs (PD-28). **Only these four swap-prone
  publishers** — leave every other publisher untouched.
- `task/step.ts` — `recordApprovalDenial` → options obj (PD-41a). Also update its
  `addUsageAndSave`, `runValidation`, and `validateAndCommit`-adjacent call sites for the
  signature changes above.
- `hooks/sink.ts` — `runBuiltinsAndEntriesAndReport` (the 6-positional internal fn at the
  cited line `:40`) → options obj (PD-41a). `createHookSink`'s own `(hooks, ctx, bus)`
  signature is fine — do not change it.
- `context-routing/assessment.ts` — `determineFit` (4 positional booleans) → options obj
  (PD-41a).
- `evidence/review-packet/sections.ts` — `buildFinalReview` (5 positional) → options obj
  (PD-41a).

**Call-site files this brief must also edit** (they hold callers of the changed
signatures; you own only the call lines, not unrelated logic in them — build on any
edits earlier briefs already made):

- `planning/full.ts`, `planning/instant.ts`, `planning/quick.ts`, `planning/speckit.ts`
  (callers of `runBriefQualityGate`, `handlePlanningFailure`,
  `collectAndPersistClarifications`, `addUsageAndSave`).
- `session-lifecycle.ts` (caller of `createQueueHandler`/`createClearQueueHandler`).
- `escalation/escalation.ts` (caller of `runEscalationTier`).
- `escalation/step.ts` (callers of `validateAndCommit`, `addUsageAndSave`,
  `promoteStagedChanges`).
- `task/apply-changed-files.ts` (caller of `promoteStagedChanges`).
- `escalation/local-retries.ts` (caller of `publishRetry`).
- `budget/budget.ts` (callers of `publishBudgetWarning`/`Paused`/`Exceeded`).
- `planner-review.ts`, `approval/approval.ts` (callers of `addUsageAndSave`).
- `run/run.ts` (caller of `applyPostPlanDrain`).
- `recovery/builders/*` and any other caller of `buildFinalReview` (grep — see step 19).
- Test files that call the changed signatures must compile: at minimum
  `validation.test.ts` (16 `runValidation` calls), `events.test.ts`,
  `planning/shared.test.ts`, `task/retry.test.ts`. Update call shapes mechanically; do
  **not** rewrite test intent (test-behavior changes are B15).

This brief **creates** no new files and **deletes** no files.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| PD-01 | high | `engine/orchestrator/clarifications.ts:13-23` | `collectAndPersistClarifications` 9 positional → one options obj; fold `projectDir/sessionId/bus/persistTranscript` (reuse `SessionRef`/`BusContext` fields). |
| PD-02 | high | `engine/orchestrator/queue.ts:46-55` | `createQueueHandler` 8 positional → options obj; the sole caller (`installQueueHandler`) already holds `InstallQueueHandlerOpts` — forward it. |
| PD-03 | med | `engine/orchestrator/queue.ts:95-101` | `createClearQueueHandler` 5 positional → options obj; share a `QueueHandlerContext`. |
| PD-04 | high | `engine/orchestrator/native-injection.ts:6-14` | `dispatchNativeInjection` 7 positional → options obj; pair `{ getState, setState }`. |
| PD-05 | high | `engine/orchestrator/state-ops.ts:75-78` | `addUsageAndSave` 6 positional → `WorkflowPersistenceContext` first param. |
| PD-06 | high | `engine/orchestrator/escalation/validate-and-commit.ts:17-26` | `validateAndCommit` 8 positional → options obj (keep the dead branch — DC-02 is B14). |
| PD-07 | high | `engine/orchestrator/run/init.ts:81-88` | `initializeWorkflow` — fold the 5 extra positionals (`sessionId`, `summaryBase`, `metadata`, `setTrackedState`, `resumeHolder`) into the options shape. |
| PD-08 | high | `engine/orchestrator/run/phases.ts:30-36` | `applyPostPlanDrain` 5 positional → `{ ctx, state, setTrackedState }`. |
| PD-09 | high | `engine/orchestrator/planning/shared.ts:56-69` | `runBriefQualityGate` (5) + `handlePlanningFailure` (5) → options objs. |
| PD-10 | med | `engine/orchestrator/planning/rewind.ts:21-28` | `handleRewindSpec`/`handleRewindPlan` — fold the trailing positionals into the options object. |
| PD-11 | med | `engine/orchestrator/escalation/run-escalation-tier.ts:32-48` | `runEscalationTier` + `runIntermediateTier`/`runHintTier`/`runFullTier` share a 5–6 positional shape → one `TierStepInput`. |
| PD-12 | high | `engine/orchestrator/validation.ts:24-32,142-150` | `Validator.runValidation` 7 positional → options obj; derive `taskId` from `task.id` (drop the redundant param). |
| PD-13 | high | `engine/orchestrator/evidence/persistence.ts:40,78-86,96` | `persistTaskEvidence`/`persistRejectionEvidence`/`persistApprovalEvidence` → options objs (thread `(ctx, opts)`); `persistRejectionEvidence` had 7 positional with 4 adjacent strings. |
| PD-14 | high | `engine/orchestrator/approval/staged-project.ts:54-59` | `promoteStagedChanges(projectDir, stagedProjectDir, …)` — two adjacent same-type dir strings → options obj naming the two roles. |
| PD-26 | med | `engine/orchestrator/transcript-rebuild.ts:29-42` | `compactResumeTranscript` 6 positional re-flattening `compactTranscript`'s opts → take/forward an options object. |
| PD-28 | m/l | `engine/orchestrator/events.ts:111,136` | `publishRetry` (adjacent `attempt`/`maxRetries`) + `publishBudgetPaused`/`Warning`/`Exceeded` (adjacent numbers) → options objs. Only these four. |
| PD-41a | l–m | `task/step.ts:61` (`recordApprovalDenial`), `hooks/sink.ts:40` (`runBuiltinsAndEntriesAndReport`), `context-routing/assessment.ts:16` (`determineFit`), `evidence/review-packet/sections.ts:300` (`buildFinalReview`) | options objs for each. |
| DRY-04 | high | `engine/orchestrator/planning/rewind.ts:70-187` | extract `finishPlanAndBriefsApproval({...})` for the duplicated PLAN_DONE → plan-approval → regenerate-if-needed → quality-gate → briefs-approval → `publishPlanApproved` tail shared by `handleRewindSpec` and `handleRewindPlan`. |

Cross-check against the Coverage summary line for B06: `PD-01..14,26,28,41a; DRY-04`. All
present above.

## Required changes

Work file-by-file. The reusable types already exist — **do not re-declare them**:

- `WorkflowContext` — `src/engine/orchestrator/types.ts:45`.
- `PlannerCallbacksContext` — `src/engine/orchestrator/types.ts:70` (a `Pick<WorkflowContext, …>`).
- `SessionRef` — `src/core/types/session-ref.ts` (`{ projectDir; sessionId }`).
- `BusContext` — `src/engine/types/bus-context.ts` (`{ bus; phase }`).
- `InstallQueueHandlerOpts` — `src/engine/orchestrator/session-lifecycle.ts:76`.
- `EscalationContext` — `src/engine/orchestrator/escalation/types.ts:24` (`WorkflowContext & {…}`).

1. **`types.ts` — add `WorkflowPersistenceContext` (PD-05 support).** Add, importing
   `EventBus` and `SessionRef`:
   ```ts
   import type { SessionRef } from '../../core/types/session-ref.js';
   export type WorkflowPersistenceContext = SessionRef & { bus: EventBus };
   ```
   Because `WorkflowContext` and `EscalationContext` are structurally assignable to this
   (they expose `projectDir`, `sessionId`, `bus`), the ~7 callers that already hold
   `wctx`/`ctx` can pass it unchanged; only loose callers construct
   `{ projectDir, sessionId, bus }`.

2. **`state-ops.ts` — `addUsageAndSave` (PD-05).** Current signature:
   ```ts
   export function addUsageAndSave(projectDir, sessionId, state, category, usage, bus): WorkflowState
   ```
   Change to `(ctx: WorkflowPersistenceContext, state: WorkflowState, category: UsageCategory, usage: TokenDelta | null | undefined): WorkflowState`. Inside, use
   `ctx.projectDir`/`ctx.sessionId`/`ctx.bus`. Import `WorkflowPersistenceContext` from
   `./types.js`. Leave `transitionAndSave`, `mergePersistedMessageQueue`,
   `refreshAndPersistCode`, `publishPlanApproved` **unchanged**.
   Update all 10 non-test callers (each already has a `wctx`/`ctx` or local
   `projectDir/sessionId/bus`):
   - `planner-review.ts:29` → `addUsageAndSave({ projectDir, sessionId, bus }, opts.state, 'planner', result.usage)`
   - `planning/rewind.ts:44` and `:134` → `addUsageAndSave(wctx, state, 'planner', regenResult.usage)`
   - `task/step.ts:158` → `addUsageAndSave(wctx, implState.state, 'implementer', implState.implResult.usage)`
   - `planning/quick.ts:45`, `planning/instant.ts:68`, `planning/full.ts:82` → `addUsageAndSave(wctx, state, 'planner', planResult.usage)`
   - `escalation/step.ts:44` → `addUsageAndSave(ctx, state, usageCategory, retryResult.usage)`
   - `escalation/run-escalation-tier.ts:149` → `addUsageAndSave(ctx, state, 'escalation', tier1Result.usage)`
   - `approval/approval.ts:67` → `addUsageAndSave({ projectDir, sessionId, bus }, state, 'planner', regenResult.usage)`

3. **`clarifications.ts` — `collectAndPersistClarifications` (PD-01).** Replace the 9
   positional params with one options object. Suggested shape (reuse `WorkflowContext`
   where the caller has it):
   ```ts
   type CollectClarificationsOptions = {
     questions: ClarificationQuestion[];
     projectDir: string;
     sessionId: string;
     state: WorkflowState;
     onQuestionAsked: (question, index, total) => Promise<string>;
     persistTranscript: boolean;
     bus: EventBus;
     metadata?: SpecMetadata | null;
     planner?: Planner;
   };
   ```
   Update the internal `transitionAndSave(...)` and `dispatchNativeInjection(...)` calls
   to the new shapes (steps 2/4). Sole caller is `planning/full.ts:87`:
   ```ts
   state = await collectAndPersistClarifications({
     questions: collectedQuestions, projectDir, sessionId, state,
     onQuestionAsked: callbacks.onQuestionAsked, persistTranscript: config.workflow.persistTranscript,
     bus: wctx.bus, metadata, planner,
   });
   ```
   (Note `callbacks.onQuestionAsked` is optional on the type but the call site already
   guards `collectedQuestions`/conversational mode — preserve the existing guard; pass
   the function only when defined, or keep the param required and let the existing
   non-null guarantee at the call site hold. Match the current non-null behavior.)

4. **`native-injection.ts` — `dispatchNativeInjection` (PD-04).** Replace the 7
   positional params with one options object pairing get/set:
   ```ts
   type DispatchNativeInjectionOptions = {
     message: QueuedMessage; planner: Planner; projectDir: string; sessionId: string;
     getState: () => WorkflowState; setState: (s: WorkflowState) => void; bus: EventBus;
   };
   ```
   Update the internal `transitionAndSave` call. Update the 2 callers:
   - `clarifications.ts:57` (inside the loop) → object form, `getState: () => state, setState: (s) => { state = s; }`.
   - `queue.ts:72` (inside `createQueueHandler`) → object form.

5. **`queue.ts` — `createQueueHandler` (PD-02), `createClearQueueHandler` +
   `QueueHandlerContext` (PD-03).** Introduce a shared context type for the get/set pair:
   ```ts
   export type QueueHandlerContext = {
     projectDir: string; sessionId: string;
     getState: () => WorkflowState | undefined;
     setState: (s: WorkflowState) => void;
     bus: EventBus;
   };
   ```
   `createQueueHandler(opts: QueueHandlerContext & { persistTranscript: boolean; planner: Planner; serialize: StateSerializer })`.
   `createClearQueueHandler(ctx: QueueHandlerContext)`. Update the body to read from the
   object and call `dispatchNativeInjection` (step 4) in object form. `enqueueUserMessage`
   and `clearPendingQueue`/`drainQueue` are **not** named findings — leave them positional
   (they take `(projectDir, sessionId, state, …)` but are not in scope; do not expand).
   Update the sole caller `session-lifecycle.ts:89,99` (`installQueueHandler`) to forward
   `InstallQueueHandlerOpts` fields:
   ```ts
   opts.sinks.setQueueHandler(createQueueHandler({
     projectDir: opts.projectDir, sessionId: opts.sessionId,
     getState: opts.getTrackedState, setState: opts.setTrackedState, bus: opts.bus,
     persistTranscript: opts.config.workflow.persistTranscript, planner: opts.planner, serialize,
   }));
   opts.sinks.setClearQueueHandler?.(createClearQueueHandler({
     projectDir: opts.projectDir, sessionId: opts.sessionId,
     getState: opts.getTrackedState, setState: opts.setTrackedState, bus: opts.bus,
   }));
   ```

6. **`validate-and-commit.ts` — `validateAndCommit` (PD-06).** Replace the 8 positional
   params with one options object:
   ```ts
   type ValidateAndCommitOptions = {
     ctx: EscalationContext; task: Task; state: WorkflowState;
     method: TaskCompletionMethod;
     transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
     retryCount: number; commitSuffix?: string; preApprovedChangedFiles?: string[];
   };
   ```
   Keep the entire body, **including** the `if (preApprovedChangedFiles === undefined)`
   branch (its removal is DC-02 / B14). Update the internal `runValidation` call to the
   new options shape (step 12). Update the sole caller `escalation/step.ts:132`:
   ```ts
   const commitResult = await validateAndCommit({ ctx: retryCtx, task, state, method, transitionType, retryCount: attempts, commitSuffix, preApprovedChangedFiles: actualChangedFiles });
   ```

7. **`run/init.ts` — `initializeWorkflow` (PD-07).** The function is
   `(opts: RunWorkflowOptions, sessionId, summaryBase, metadata, setTrackedState, resumeHolder)`.
   Fold the 5 trailing positionals into a single options object so the call reads as one
   bag. Recommended: a new local param type
   ```ts
   type InitializeWorkflowArgs = {
     opts: RunWorkflowOptions; sessionId: string; summaryBase: SummaryBase;
     metadata: SpecMetadata; setTrackedState: (s: WorkflowState) => void; resumeHolder: ResumeContextHolder;
   };
   ```
   and destructure inside. Update the sole production caller `run/run.ts:70` plus the
   test callers in `run/init-hook-trust.test.ts` (6 calls) and `run/init.test.ts` (1 call).
   Do **not** restructure `RunWorkflowOptions` itself.

8. **`run/phases.ts` — `applyPostPlanDrain` (PD-08).** Current:
   `(projectDir, sessionId, state, bus, setTrackedState)`. Change to
   `applyPostPlanDrain(opts: { ctx: WorkflowPersistenceContext; state: WorkflowState; setTrackedState: (s: WorkflowState) => void })`.
   Use `opts.ctx.projectDir`/`sessionId`/`bus` for the internal `drainQueue(...)`. Update
   the sole caller `run/run.ts:95`:
   ```ts
   const postPlanState = applyPostPlanDrain({ ctx: wctx, state: planning.state, setTrackedState: (s) => { trackedState = s; } });
   ```

9. **`planning/shared.ts` — `runBriefQualityGate` + `handlePlanningFailure` (PD-09).**
   Param shapes only — **do not split this file** (B10 owns SRP-02).
   - `runBriefQualityGate(opts: { tasks: Task[]; projectDir: string; sessionId: string; bus: EventBus; phase: Phase }): { report; ok }`.
   - `handlePlanningFailure(opts: { err: unknown; projectDir: string; sessionId: string; state: WorkflowState; wctx: PlannerCallbacksContext }): { state; tasks; cancelled: true }`.
   Update all callers:
   - `runBriefQualityGate`: `instant.ts:84`, `quick.ts:47`, `full.ts:130`, `speckit.ts:187`, `rewind.ts:92` & `:170` (these move into the new helper from step 11 — see DRY-04), `run/phases.ts:152`, and the 3 in-file callers `shared.ts:242,263,287`.
   - `handlePlanningFailure`: `instant.ts:64,71,87`, `quick.ts:41,50`, `full.ts:67`.
   Convert each to the object form.

10. **`planning/rewind.ts` — fold extras into options (PD-10).** `handleRewindSpec` is
    `(opts, rewindPending, skipPlanApproval, metadata, skillsContext, state)`;
    `handleRewindPlan` is `(opts, rewindPending, skipPlanApproval, metadata, state)`.
    Fold the trailing positionals into a single object per function, e.g.
    `handleRewindSpec(args: { opts: PlanningPhaseOptions; rewindPending: RewindPending; skipPlanApproval: boolean; metadata: SpecMetadata; skillsContext: string | undefined; state: WorkflowState })`
    and the analogous shape (no `skillsContext`) for `handleRewindPlan`. Update the
    callers in `full.ts:176` and `:178` (`runFullPlanning`).

11. **`planning/rewind.ts` — extract `finishPlanAndBriefsApproval` (DRY-04).** Both
    `handleRewindSpec` (lines ~62-109) and `handleRewindPlan` (lines ~139-188) end with
    the identical tail after computing `tasks`:
    ```
    transitionAndSave(PLAN_DONE) → publishPlannerStatus
    → if (!skipPlanApproval && !autoApprovePlan): runApprovalLoop('plan') + regenerateTasksIfNeeded
    → runBriefQualityGate → runBriefsApprovalLoop → (if rejected return cancelled) → publishPlanApproved
    ```
    Extract one helper **in this file** (do not put it in `shared.ts` — B10 splits that):
    ```ts
    async function finishPlanAndBriefsApproval(args: {
      wctx: PlannerCallbacksContext; planner: Planner; state: WorkflowState; tasks: Task[];
      skipPlanApproval: boolean; metadata: SpecMetadata;
    }): Promise<PlanningPhaseResult>
    ```
    It runs PLAN_DONE → plan-approval-loop → regenerate-if-needed → quality-gate →
    briefs-approval-loop → `publishPlanApproved`, returning `{ state, tasks, cancelled }`.
    Both rewind handlers call it after their regenerate step. Preserve exact ordering and
    early-return-on-rejected semantics. Use the step-9 object form for
    `runBriefQualityGate` inside the helper. (`runNewPlanning` in `full.ts` shares a
    *similar* tail but with `blocksPlanGate`/`deferBriefGate` control flow — it is **not**
    part of DRY-04's scope; leave it, do not force-fit the helper there.)

12. **`validation.ts` — `Validator.runValidation` (PD-12).** Change the interface method
    and the implementation to take one options object and derive `taskId` from `task.id`:
    ```ts
    runValidation: (opts: {
      task: Task; projectDir: string; config: Config; bus: EventBus; phase: Phase;
      discoveredValidation?: DiscoveredValidation;
    }) => Promise<ValidationResult[]>;
    ```
    Inside, replace `taskId` usages with `opts.task.id`. **Keep `findAffectedTestFile` on
    the interface** (OE-02 / B16 removes it — not here). Update the 2 non-test callers:
    - `task/step.ts:209` → `wctx.validator.runValidation({ task, projectDir, config, bus: wctx.bus, phase: state.phase, discoveredValidation: state.discoveredValidation })`
    - `validate-and-commit.ts:94` → `ctx.validator.runValidation({ task, projectDir: ctx.projectDir, config: ctx.config, bus: ctx.bus, phase: state.phase, discoveredValidation: state.discoveredValidation })`
    Update the 16 calls in `validation.test.ts` to the object form (mechanical: drop the
    now-redundant `'t1'` taskId arg, wrap the rest). Do not change test assertions.

13. **`evidence/persistence.ts` — `persist*Evidence` family (PD-13).** Convert all three
    exported functions to `(opts: {...})` form keeping `wctx`/`state` named:
    - `persistTaskEvidence({ wctx, state, task, recordKind, details })`.
    - `persistRejectionEvidence({ wctx, state, reason, actionClass, tier, actionDescription, taskId? })` (was 7 positional with 4 adjacent strings).
    - `persistApprovalEvidence({ wctx, state, decision, taskId? })`.
    Update **all** callers:
    - `persistTaskEvidence`: `task/step.ts:233`, `task/pre-task.ts:45`, `task/retry.ts:136`.
    - `persistApprovalEvidence`: `task/step.ts:131`, `task/run-implementation.ts:91`, `task/apply-changed-files.ts:100`.
    - `persistRejectionEvidence`: called only inside `recordApprovalDenial` (`task/step.ts:71`) — update via step 18.
    Note the wrappers in `escalation/retry-evidence.ts` (`persistRetryApprovalEvidence`
    at line 8, `persistRetryRejectionEvidence` at line 33) call
    `persistApprovalEvidence`/`persistRejectionEvidence` internally — update those internal
    calls to the new object form. The wrapper *signatures* (`(ctx, state, task, gate)`)
    are **not** findings; leave them positional, only fix their bodies.
    `getOrCreateLedger`/`readEvidenceLedger`/`writeEvidenceLedger` are **not** findings —
    leave them.

14. **`approval/staged-project.ts` — `promoteStagedChanges` (PD-14).** The two adjacent
    same-type dir strings are the bug risk. Convert to:
    ```ts
    export async function promoteStagedChanges(opts: {
      targetProjectDir: string; stagedProjectDir: string; files: string[]; expectedCurrentContents: FileContentSnapshot;
    }): Promise<PromoteStagedChangesResult>
    ```
    Inside, replace `projectDir` with `opts.targetProjectDir` (the destination that gets
    written) and `stagedProjectDir` with `opts.stagedProjectDir` (the source read from) —
    preserve the exact current direction (writes go to `projectDir`, reads of new content
    come from `stagedProjectDir`). Update the 2 callers:
    - `task/apply-changed-files.ts:104` → `promoteStagedChanges({ targetProjectDir: projectDir, stagedProjectDir: staged.projectDir, files: taskChangedFiles, expectedCurrentContents: preApprovalChangedFileContents })`
    - `escalation/step.ts:110` → `promoteStagedChanges({ targetProjectDir: ctx.projectDir, stagedProjectDir: staged.projectDir, files: stagedChangedFiles, expectedCurrentContents: preApprovalChangedFileContents })`

15. **`escalation/run-escalation-tier.ts` — `TierStepInput` (PD-11).** Introduce:
    ```ts
    type TierStepInput = {
      ctx: EscalationContext; task: Task; state: WorkflowState; lastError: string; priorAttempts: number;
    };
    ```
    Change `runEscalationTier(config: TierConfig, input: TierStepInput)` and the three
    private fns `runIntermediateTier`/`runHintTier`/`runFullTier` to take `TierStepInput`.
    Inside, destructure `{ ctx, task: initialTask, state, lastError, priorAttempts }`
    (rename `task`→`initialTask` locally to keep the rest of each body unchanged, or
    rename the body refs — pick one and be consistent). Update the 3 callers in
    `escalation/escalation.ts:60,65,70`:
    ```ts
    const tier0 = await runEscalationTier(INTERMEDIATE_TIER, { ctx, task: retries.task, state: retries.state, lastError: retries.lastError, priorAttempts: retries.attempts });
    const tier1 = await runEscalationTier(HINT_TIER, { ctx, task: tier0.task, state: tier0.state, lastError: tier0.lastError, priorAttempts: tier0.attempts });
    const tier2 = await runEscalationTier(FULL_TIER, { ctx, task: tier1.task, state: tier1.state, lastError: tier1.lastError, priorAttempts: tier1.attempts });
    ```
    Keep `TierConfig` as the first positional discriminant (it is not swap-prone).

16. **`transcript-rebuild.ts` — `compactResumeTranscript` (PD-26).** It currently takes 6
    positional args that re-flatten `compactTranscript`'s options. Convert to one options
    object:
    ```ts
    export async function compactResumeTranscript(opts: {
      projectDir: string; sessionId: string;
      planner: { summarize: ...; summarizeStructured?: ... };
      keepRecentCount: number; format?: ResolvedCompactionFormat; onFallback?: (text) => void | Promise<void>;
    }): Promise<TranscriptCompactionResult>
    ```
    Default `format` to `'freeform'` inside. Update the sole caller
    `resume-context.ts:39` (`autoCompactResumeContext`) to the object form. (Do not delete
    the wrapper — the audit offered "or delete" but the wrapper has a single caller and
    keeping it is the lower-risk choice.)

17. **`events.ts` — swap-prone publishers (PD-28).** Convert only these four to options
    objects (mirror the existing `publishEscalate` `BusContext & {…}` pattern or take a
    second opts arg — match the file's prevailing style; `publishEscalate` uses
    `(opts: BusContext & {…})`):
    - `publishRetry(opts: BusContext & { taskId: TaskId; attempt: number; maxRetries: number; error: string })`.
    - `publishBudgetWarning(opts: BusContext & { currentCost: number; maxBudget: number })`.
    - `publishBudgetPaused(opts: BusContext & { currentCost: number; maxBudget: number; threshold: number })`.
    - `publishBudgetExceeded(opts: BusContext & { currentCost: number; maxBudget: number })`.
    Update callers:
    - `publishRetry`: `escalation/local-retries.ts:27,30` → `publishRetry({ bus: ctx.bus, phase: state.phase, taskId: task.id, attempt, maxRetries, error: lastError })`.
    - `publishBudgetWarning`: `budget/budget.ts:115`; `publishBudgetPaused`: `budget/budget.ts:124`; `publishBudgetExceeded`: `budget/budget.ts:140` → object form.
    - `events.test.ts:149,156` → object form.
    Leave every other `publish*` function in this file unchanged.

18. **`task/step.ts` — `recordApprovalDenial` (PD-41a).** Convert
    `(wctx, state, task, decision, message)` to
    `recordApprovalDenial(opts: { wctx: WorkflowContext; state: WorkflowState; task: Task; decision: GateDecision; message: string })`.
    Update its sole caller (in-file). Also apply the step-2/12/13 call-site updates in this
    file (`addUsageAndSave`, `runValidation`, `persist*Evidence`).

19. **`evidence/review-packet/sections.ts` — `buildFinalReview` (PD-41a).** Convert
    `(projectDir, sessionId, requestedStatus, ledger, missing)` to
    `buildFinalReview(opts: { projectDir: string; sessionId: string; requestedStatus: 'written' | 'failed'; ledger: EvidenceLedger | null; missing: string[] })`.
    It has exactly one caller — `evidence/review-packet/build.ts:300` — update it:
    `await buildFinalReview({ projectDir: opts.projectDir, sessionId: opts.sessionId, requestedStatus: opts.finalReviewStatus, ledger, missing })`.

20. **`hooks/sink.ts` — `runBuiltinsAndEntriesAndReport` (PD-41a, cited line `:40`).**
    Convert `runBuiltinsAndEntriesAndReport(builtins, entries, hookEvent, event, ctx, bus)`
    (6 positional) to one options object:
    `runBuiltinsAndEntriesAndReport(opts: { builtins: ReturnType<typeof activeBuiltinsFor>; entries: HookEntry[]; hookEvent: HookEvent; event: EngineEvent; ctx: HookContext; bus: EventBus })`.
    Update its sole caller `createHookSink` at `sink.ts:16`
    (`void runBuiltinsAndEntriesAndReport({ builtins, entries, hookEvent, event, ctx, bus })`).
    Converting the smaller internal `runAndReport(label, phase, bus, fn)` to an options
    object too is optional (mild, 4 params) but consistent; do it if convenient.
    (`createHookSink`'s own `(hooks, ctx, bus)` signature is fine — do not change it.)

21. **`context-routing/assessment.ts` — `determineFit` (PD-41a).** Convert
    `(currentCodeTruncated, mode, formattedFit, untruncatedFit)` (4 positional, two
    same-typed `TaskContextFit`) to
    `determineFit(opts: { currentCodeTruncated: boolean; mode: CurrentCodeContextMode; formattedFit: TaskContextFit; untruncatedFit: TaskContextFit })`.
    Update its sole caller in `assessProfile` (same file, ~line 44).

22. **Sweep for misses.** After the above, run a typecheck and fix any remaining call
    sites the greps didn't surface. Then grep each changed symbol once more to confirm no
    positional call remains:
    ```bash
    grep -rn "collectAndPersistClarifications(\|dispatchNativeInjection(\|createQueueHandler(\|createClearQueueHandler(\|addUsageAndSave(\|validateAndCommit(\|applyPostPlanDrain(\|runBriefQualityGate(\|handlePlanningFailure(\|runEscalationTier(\|promoteStagedChanges(\|compactResumeTranscript(\|recordApprovalDenial(\|buildFinalReview(\|determineFit(" src/ --include="*.ts"
    grep -rn "\.runValidation(\|publishRetry(\|publishBudgetPaused(\|publishBudgetWarning(\|publishBudgetExceeded(" src/ --include="*.ts"
    ```
    Every hit must be the new object form (or a definition).

## Out of scope (owned elsewhere — do NOT touch)

- **`transitionAndSave` and `mergePersistedMessageQueue` (`state-ops.ts`)** — keep
  positional. They are **not** named findings; PD-05's fix targets only `addUsageAndSave`.
  Their ~25-file blast radius (recovery/actions.ts, task/loop.ts, planning/*, etc.) is
  intentionally excluded; the collision map deliberately does **not** list `state-ops.ts`,
  which in this serialized workflow means no signature rewrite. PD-05 is fully satisfied by
  `addUsageAndSave` plus the queue cluster (PD-02/PD-03). Do not "finish the prefix family."
- **The dead `preApprovedChangedFiles === undefined` branch in `validate-and-commit.ts`
  (lines 40-89)** → DC-02, owned by **B14**. Convert the signature (PD-06) but keep the
  branch.
- **Removing `findAffectedTestFile` from the `Validator` interface** → OE-02, owned by
  **B16**. Keep it on the interface; only change `runValidation`.
- **`planning/shared.ts` file split into 3 modules** → SRP-02, owned by **B10**. You only
  change param shapes here.
- **`evidence/persistence.ts` extraction to `core/evidence/ledger.ts` and shared
  selectors** → AR-04/EH-08 (B09) and DRY-51 (B12). You only change param shapes here.
- **`run/init.ts` / `run/phases.ts` further SRP extraction** (`auto-split-review.ts`) →
  SRP-09, owned by **B10**.
- **`escalation/step.ts` + `apply-changed-files.ts` `gateAndPromoteChangedFiles`
  extraction** → DRY-03, owned by **B12**. You only touch the `promoteStagedChanges` and
  `validateAndCommit` and `addUsageAndSave` call lines in those files.
- **`runNewPlanning` (full.ts)** — not in DRY-04 scope; do not force the new helper on it.
- **Providers/planners/runners parameter objects** (`Planner` interface, `api.ts`,
  `pricing.ts`, `openai-compat.ts`, etc.) → **B07**. Core/CLI/features parameter objects
  → **B08**. Do not touch.
- **`events.ts` publishers other than the four named in PD-28** — leave untouched.

## Acceptance criteria

- [ ] Every finding ID above (PD-01..14, PD-26, PD-28, PD-41a, DRY-04) is addressed in
  the code; cross-checked against the B06 Coverage-summary line.
- [ ] `WorkflowContext`, `SessionRef`, `BusContext`, `PlannerCallbacksContext`,
  `InstallQueueHandlerOpts` are **reused**, not re-declared. Exactly three new types are
  introduced: `WorkflowPersistenceContext`, `QueueHandlerContext`, `TierStepInput`.
- [ ] `transitionAndSave`/`mergePersistedMessageQueue` signatures are unchanged.
- [ ] `validate-and-commit.ts` still contains the `preApprovedChangedFiles === undefined`
  branch; `Validator` interface still declares `findAffectedTestFile`.
- [ ] `promoteStagedChanges` writes to `targetProjectDir` and reads new content from
  `stagedProjectDir` (direction preserved); no behavior change.
- [ ] `runValidation` derives `taskId` from `task.id`; every caller (incl. the 16 in
  `validation.test.ts`) compiles in the object form; no test assertion changed.
- [ ] `finishPlanAndBriefsApproval` lives in `planning/rewind.ts` (not `shared.ts`); both
  rewind handlers use it; ordering and early-return-on-rejected semantics preserved.
- [ ] Only the four PD-28 publishers changed; all others in `events.ts` untouched.
- [ ] No new `!`/broad `as`/`any`/barrels/classes/memoization; `.js` imports; engine/
  imports nothing from `react`/`ink`/`features`/`components`/`hooks`; no decorative
  comments.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (call shapes updated where signatures changed; behavior intent
  unchanged).

## Tests

```bash
npm test -- src/engine/orchestrator src/engine/hooks
npm run typecheck
npm run lint
```

(The broad `src/engine/orchestrator` glob covers `validation.test.ts`, `events.test.ts`,
`planning/shared.test.ts`, `task/retry.test.ts`, `task/loop.test.ts`, and the escalation
tests — all of which reference changed signatures.)

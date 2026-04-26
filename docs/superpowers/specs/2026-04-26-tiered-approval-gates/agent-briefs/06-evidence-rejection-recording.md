# 06 — Evidence Rejection Recording

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Agent: Evidence Rejection Recording implementer
Brief: 06 of 06 (Tiered Approval Gates spec)

## Intent

Extend the evidence ledger schema to record action-level rejection events with reasons. Add helpers to append rejections and build the summary. Wire the `approval_rejected` engine event (emitted by brief 02) into the evidence ledger write path. Ensure the summary screen can display rejection count.

## Scope

**In bounds:**
- `src/core/schemas/evidence.ts` — add `EvidenceRejectionSchema`, extend `EvidenceLedgerSchema` with optional `rejections` array
- `src/engine/orchestrator/evidence.ts` — add `recordRejectionEvidence` helper + `buildEvidenceSummary` extension
- `src/engine/orchestrator/evidence.test.ts` — extend with rejection recording tests
- `src/engine/orchestrator/task-step.ts` — subscribe to `approval_rejected` event and record in ledger (or call helper at gate-decision sites)
- `src/core/schemas/summary.ts` — add `rejectionCount` to `evidenceSummary` (if it exists as a schema)

**Out of bounds:**
- Do not modify `src/engine/orchestrator/tiered-approval.ts` (brief 02 owns event emission).
- Do not modify `src/features/summary/screen.tsx` beyond reading the already-present `evidenceSummary.rejectionCount` field if the summary schema is extended.
- Do not touch the approvals store schema (brief 03 owns that).
- Do not bump `EvidenceLedger.version` — new field is optional, old ledgers remain valid.

## Code Context

Read before implementing:

- `src/core/schemas/evidence.ts` — current `EvidenceLedgerSchema`, `EvidenceTaskSchema`, `TaskIdSchema`
- `src/engine/orchestrator/evidence.ts` — `recordLocalTaskEvidence`, `buildEvidenceSummary`, `writeEvidenceLedger`, `readEvidenceLedger` — follow the same functional, pure style
- `src/engine/orchestrator/evidence.test.ts` — existing test patterns for ledger mutation helpers
- `src/engine/orchestrator/task-step.ts` — where `writeEvidenceLedger` is called; integration point for recording rejections
- `src/engine/events/types.ts` — `approval_rejected` event variant (from brief 02)
- `src/core/schemas/summary.ts` — `evidenceSummary` shape; check if `rejectionCount` already exists

## Implementation Plan

### 1. Add `EvidenceRejectionSchema` to `src/core/schemas/evidence.ts`

```ts
export const EvidenceRejectionSchema = z.object({
  ts: z.string(),                          // ISO timestamp
  tier: z.enum(['sticky', 'confirm']),
  actionClass: z.enum([
    'read', 'write_in_scope', 'validation',
    'write_out_of_scope', 'destructive', 'network', 'package_change',
  ]),
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  reason: z.string(),
});
export type EvidenceRejection = z.infer<typeof EvidenceRejectionSchema>;
```

Extend `EvidenceLedgerSchema`:

```ts
rejections: z.array(EvidenceRejectionSchema).optional(),
```

### 2. Add `recordRejectionEvidence` helper in `src/engine/orchestrator/evidence.ts`

```ts
export type RecordRejectionEvidenceInput = {
  ledger: EvidenceLedger;
  tier: 'sticky' | 'confirm';
  actionClass: EvidenceRejection['actionClass'];
  actionDescription: string;
  taskId?: TaskId;
  reason: string;
};

export function recordRejectionEvidence(
  input: RecordRejectionEvidenceInput,
): EvidenceLedger
```

The function clones the ledger, appends to `rejections`, updates `generatedAt`, and returns the updated ledger. It does not write to disk. Callers are responsible for calling `writeEvidenceLedger`.

### 3. Extend `buildEvidenceSummary` in `src/engine/orchestrator/evidence.ts`

Add `rejectionCount: number` to the return value:

```ts
rejectionCount: ledger.rejections?.length ?? 0,
```

Check if `Summary['evidenceSummary']` type already has `rejectionCount`. If not, add it to `src/core/schemas/summary.ts` as an optional `z.number().nonnegative()` field.

### 4. Wire rejection recording in `src/engine/orchestrator/task-step.ts`

After `gateAction` returns `{ allow: false }`, call `recordRejectionEvidence` and `writeEvidenceLedger`. The existing `persistTaskEvidence` helper pattern in `task-step.ts` can be reused:

```ts
// After gateAction returns deny:
function persistRejectionEvidence(
  wctx: WorkflowContext,
  event: EngineEventOf<'approval_rejected'>,
): void {
  try {
    const existing = readEvidenceLedger(wctx.projectDir, wctx.sessionId);
    if (!existing) return;
    const updated = recordRejectionEvidence({
      ledger: existing,
      tier: event.tier,
      actionClass: event.actionClass,
      actionDescription: event.actionDescription ?? '',
      taskId: event.taskId,
      reason: event.reason,
    });
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, updated);
  } catch {
    // non-fatal: rejection evidence loss is acceptable vs. crashing the run
  }
}
```

Call `persistRejectionEvidence` at the site in `task-step.ts` where the gate deny path is handled (after the gate decision is returned, before the task errors out).

Per brief 02, `gateAction` is called in `task-step.ts` around line 164 (after `publishTaskStart`, before `withContinuationLoop`). The `approval_rejected` event is emitted by `gateAction` before returning `{ allow: false }`. Call `persistRejectionEvidence` at the deny-gate site, immediately after `gateAction` returns `{ allow: false }`, using the event data surfaced in the return value or by reading the most-recently emitted event from the bus if the bus supports it. If neither is clean, add `reason` and `actionClass` to `GateDecision` so the call site has all needed data without parsing events.

### 5. Planner re-prompt context (optional, wired if `feedRejectionsToPlanner` is true)

In `src/engine/orchestrator/planning/shared.ts` or wherever planner context is assembled before a re-prompt, check `config.approval?.feedRejectionsToPlanner` and, if true, prepend a rejection summary to the planner prompt:

```ts
function buildRejectionContext(ledger: EvidenceLedger): string {
  const rejections = ledger.rejections ?? [];
  if (rejections.length === 0) return '';
  const lines = rejections.map(r =>
    `- [${r.tier}] ${r.actionClass}: ${r.actionDescription} (reason: ${r.reason})`,
  );
  return `Previous rejections:\n${lines.join('\n')}\n`;
}
```

This is a pure function; test it directly.

## Validation

### Tests (`src/engine/orchestrator/evidence.test.ts`)

Add to existing test suite:

- `recordRejectionEvidence` appends to `rejections` array
- `recordRejectionEvidence` with no prior rejections creates the array
- `recordRejectionEvidence` updates `generatedAt`
- `recordRejectionEvidence` is pure — does not mutate the input ledger
- `buildEvidenceSummary` returns `rejectionCount: 0` when `rejections` is undefined
- `buildEvidenceSummary` returns correct `rejectionCount` when rejections exist
- `buildRejectionContext` returns empty string for empty rejections
- `buildRejectionContext` returns formatted lines for populated rejections
- Old ledger JSON without `rejections` field parses successfully (backward compat)

## Constraints

- No imports from `ink`, `react`, or any `src/features/` path in engine or schema files.
- `recordRejectionEvidence` must be pure (no I/O); the `persistRejectionEvidence` wrapper in `task-step.ts` does the I/O.
- Rejection recording failures must not crash the task run; catch and swallow in `persistRejectionEvidence`.
- The `EvidenceLedger.version` field stays at `1`.
- No new schema fields on `EvidenceTask` — rejections are top-level on `EvidenceLedger` to capture cross-task rejections.

## Escalation

If `src/engine/orchestrator/task-step.ts` does not have an obvious integration site for gate denial (because gate action calling is not yet present before brief 02 is merged), add a TODO comment marker at the site where `gateAction` will be called and implement `persistRejectionEvidence` as a standalone exported function so brief 02 can call it directly.

If `Summary['evidenceSummary']` is defined as a TypeScript type rather than inferred from a Zod schema, add `rejectionCount?: number` directly to the type definition.

## Evidence Requirements

- Modified: `src/core/schemas/evidence.ts`
- Modified: `src/engine/orchestrator/evidence.ts`
- Modified: `src/engine/orchestrator/evidence.test.ts`
- Modified: `src/engine/orchestrator/task-step.ts`
- Modified (if needed): `src/core/schemas/summary.ts`
- All tests pass: `npm test -- src/engine/orchestrator/evidence.test.ts`
- Typecheck clean: `npm run typecheck`

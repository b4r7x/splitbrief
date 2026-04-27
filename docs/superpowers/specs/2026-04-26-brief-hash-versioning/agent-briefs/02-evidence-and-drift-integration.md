# 02 — Evidence and Drift Integration

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

**Brief 02 of 3** in the Brief Hash Versioning spec (`2026-04-26-brief-hash-versioning`). This is the final brief in the chain. It must run after brief 01 (canonical-json-and-hash) and brief 03 (task-schema-and-tests) are complete and compiling.

**Prerequisite check before starting:** run `npm run typecheck`. If it reports errors in `src/core/schemas/evidence.ts` or `src/core/brief-hash.ts`, the prerequisites are not met — do not proceed.

## Intent

Thread `briefHash` through the two runtime modules that produce session artifacts:

1. `src/engine/orchestrator/evidence.ts` — every function that creates or updates an `EvidenceLedger` must accept and propagate `briefHash`.
2. `src/engine/orchestrator/drift.ts` — `analyzeBriefDrift` must accept and include `briefHash` in the returned `DriftReport`.

No UI changes. No new artifact files. No schema changes (those are in brief 03).

## Scope

**In bounds:**
- Modify `src/engine/orchestrator/evidence.ts`.
- Modify `src/engine/orchestrator/drift.ts`.
- Modify `src/engine/orchestrator/evidence.test.ts` to cover `briefHash` propagation.
- Modify `src/engine/orchestrator/drift.test.ts` to cover `briefHash` in `DriftReport`.

**Out of bounds:**
- Do not touch `src/core/schemas/evidence.ts` (that is brief 03's responsibility).
- Do not touch callers of `createEvidenceLedger` or `analyzeBriefDrift` in `task-loop.ts`, `task-step.ts`, `final-review.ts`, or `planning/`. The callers will be updated by the handoff-packs spec when it becomes available; for now, `briefHash` defaults to `null` when callers do not supply it.
- Do not touch any planning, planner, or implementer code.
- Do not add npm dependencies.

## Code Context

### `src/engine/orchestrator/evidence.ts` (current shape)

Key exported functions and their current signatures:

```ts
export type CreateEvidenceLedgerInput = {
  sessionId: string;
  feature: string;
  mode?: WorkflowMode | undefined;
  tasks: Task[];
};
export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger;

export type RecordLocalTaskEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  status: TaskStatus;
  method?: TaskCompletionMethod | undefined;
  retries?: number | undefined;
  durationMs?: number | undefined;
  validation: ValidationResult[];
  changedFiles?: string[] | undefined;
};
export function recordLocalTaskEvidence(input: RecordLocalTaskEvidenceInput): EvidenceLedger;

export type RecordRetryOrEscalationEvidenceInput = { ... };
export function recordRetryOrEscalationEvidence(input: RecordRetryOrEscalationEvidenceInput): EvidenceLedger;

export type RecordSkippedTaskEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  reason: string;
};
export function recordSkippedTaskEvidence(input: RecordSkippedTaskEvidenceInput): EvidenceLedger;

export type RecordFinalReviewEvidenceInput = {
  ledger: EvidenceLedger;
  status: EvidenceFinalReviewStatus;
  path?: string | undefined;
};
export function recordFinalReviewEvidence(input: RecordFinalReviewEvidenceInput): EvidenceLedger;
```

All return a new `EvidenceLedger` — they are pure (no mutation). The pattern is established.

### `src/engine/orchestrator/drift.ts` (current shape)

```ts
export type AnalyzeBriefDriftInput = {
  tasks: Task[];
  changedFiles: string[];
  diff: string;
  ledger?: EvidenceLedger | null | undefined;
};

export type DriftReport = {
  version: 1;
  passed: boolean;
  score: number;
  changedFiles: string[];
  expectedFiles: string[];
  findings: DriftFinding[];
};

export function analyzeBriefDrift(input: AnalyzeBriefDriftInput): DriftReport;
```

### After brief 03 completes

`EvidenceLedger` (from `src/core/schemas/evidence.ts`) will have:
- Top-level: `briefHash: string | null | undefined`
- `EvidenceTask` entries: each `briefHash: string | null | undefined`

`DriftReport` (TypeScript type in `src/engine/orchestrator/drift.ts`) will have:
- `briefHash: string | null | undefined`

### New import needed

```ts
import { hashTaskBrief } from '../../core/brief-hash.js';
```

Add this import to `evidence.ts` and `drift.ts`.

## Implementation Plan

### 1. `src/engine/orchestrator/evidence.ts`

Add `briefHash?: string | null` to each input type that either creates a new ledger or records a new task entry:

```ts
export type CreateEvidenceLedgerInput = {
  sessionId: string;
  feature: string;
  mode?: WorkflowMode | undefined;
  tasks: Task[];
  briefHash?: string | null;          // NEW
};
```

```ts
export type RecordLocalTaskEvidenceInput = {
  // ... existing fields ...
  briefHash?: string | null;          // NEW
};
```

```ts
export type RecordRetryOrEscalationEvidenceInput = {
  // ... existing fields ...
  briefHash?: string | null;          // NEW
};
```

```ts
export type RecordSkippedTaskEvidenceInput = {
  // ... existing fields ...
  briefHash?: string | null;          // NEW
};
```

`RecordFinalReviewEvidenceInput` does **not** need `briefHash` — the final review entry does not carry a per-entry hash; it augments the existing ledger.

**In `createEvidenceLedger`:** set `ledger.briefHash = input.briefHash ?? null`. Set `task.briefHash = input.briefHash ?? null` on every seeded `EvidenceTask`.

**In `emptyEvidenceTask`:** add `briefHash: null` as a default so the seeded shape matches the schema.

**In `findOrSeed`:** when an existing entry is found and the caller passes a `briefHash`, update the entry's `briefHash` only if the existing value is `null` or `undefined`. If the existing entry already has a non-null `briefHash`, leave it — preserving the "old evidence keeps old hash" invariant.

**In `recordLocalTaskEvidence`:** pass `input.briefHash` through the `findOrSeed` / `replaceTask` pipeline by setting `next.briefHash = input.briefHash ?? next.briefHash ?? null` before calling `replaceTask`.

**In `recordRetryOrEscalationEvidence`** and **`recordSkippedTaskEvidence`:** same pattern as `recordLocalTaskEvidence`.

**Update `replaceTask`:** when it writes back the updated `EvidenceTask`, it must not strip `briefHash`.

**Update the ledger-level `briefHash`:** `replaceTask` should not modify `ledger.briefHash`. The ledger-level hash is set at creation time and stays fixed.

### 2. `src/engine/orchestrator/drift.ts`

Add `briefHash?: string | null` to `AnalyzeBriefDriftInput`:

```ts
export type AnalyzeBriefDriftInput = {
  tasks: Task[];
  changedFiles: string[];
  diff: string;
  ledger?: EvidenceLedger | null | undefined;
  briefHash?: string | null;          // NEW
};
```

Update `DriftReport` type:

```ts
export type DriftReport = {
  version: 1;
  passed: boolean;
  score: number;
  changedFiles: string[];
  expectedFiles: string[];
  findings: DriftFinding[];
  briefHash: string | null;           // NEW — always present in new reports
};
```

In `analyzeBriefDrift`: add `briefHash: input.briefHash ?? null` to the returned object.

**Do not** call `hashTaskBrief` inside `analyzeBriefDrift` — the caller supplies the pre-computed hash. This avoids double-hashing and keeps the function pure.

Note: the `readDriftReport` function currently casts the parsed JSON as `DriftReport`. After this change, old drift reports on disk will be missing `briefHash`. The TypeScript type allows `string | null` but old files have the field absent. Callers that read old drift reports should treat an absent `briefHash` as `null`. Update the return type if needed, or handle in the cast.

## Tests

### `src/engine/orchestrator/evidence.test.ts` — additions

Add test cases covering:
- `createEvidenceLedger` with `briefHash` sets it on the returned ledger and on all seeded tasks.
- `createEvidenceLedger` without `briefHash` sets `briefHash: null` on ledger and tasks.
- `recordLocalTaskEvidence` propagates `briefHash` to the updated task entry.
- Mid-run regeneration scenario:
  1. Create ledger with `briefHash: 'hash-A'`.
  2. Record task T001 completion with `briefHash: 'hash-A'`.
  3. Record task T002 completion with `briefHash: 'hash-B'` (simulating regeneration).
  4. Assert: T001's `briefHash` is still `'hash-A'`; T002's is `'hash-B'`.
  5. Assert: ledger-level `briefHash` remains `'hash-A'` (set at creation, not overwritten).
- `recordSkippedTaskEvidence` with `briefHash` preserves it.
- `readEvidenceLedger` on a serialized ledger without `briefHash` returns the ledger with `briefHash: undefined` or `null` (does not throw).

### `src/engine/orchestrator/drift.test.ts` — additions

Add test cases covering:
- `analyzeBriefDrift` with `briefHash: 'abc123'` returns a report with `briefHash: 'abc123'`.
- `analyzeBriefDrift` without `briefHash` returns a report with `briefHash: null`.
- `readDriftReport` on a legacy JSON without `briefHash` does not throw (the field will be absent; callers treat it as null).

### Existing tests that construct `Task[]`

The existing tests in `evidence.test.ts` and `drift.test.ts` use `makeTask(...)`. After brief 03 adds `briefHash` fields to the schema, these tests will continue to compile because the field is `.optional()`. No changes to existing test assertions are required unless a test explicitly checks the full shape of a returned ledger.

## Validation

```bash
npm test -- src/engine/orchestrator/evidence.test.ts src/engine/orchestrator/drift.test.ts
npm run typecheck
npm run lint
```

Full CI:

```bash
npm run test-ci
```

## Constraints

- No `class` keyword.
- No barrel files.
- ESM `.js` extensions on all imports.
- No imports from React, Ink, or `src/features/`.
- `analyzeBriefDrift` must remain a pure function — no file I/O, no `hashTaskBrief` call inside it.
- The `briefHash` parameter is always optional (callers that have not yet been updated pass nothing; the default is `null`).

## Escalation

Stop and report if:
- Brief 03 has not been implemented: `EvidenceLedger` and `EvidenceTask` types do not yet have `briefHash`. Running `npm run typecheck` will confirm with errors in `src/core/schemas/evidence.ts` — return to the coordinator.
- Brief 01 has not been implemented: `src/core/brief-hash.ts` does not exist. `npm run typecheck` will error on the new import — return to the coordinator.

## Evidence Requirements

After completion:
- All new test assertions pass.
- `npm run typecheck` reports zero errors.
- `npm run lint` reports zero new warnings.
- `readEvidenceLedger` on an old `evidence.json` without `briefHash` does not throw (verify manually or in a test).

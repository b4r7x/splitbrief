# 03 — Task Schema and Tests

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

**Brief 03 of 3** in the Brief Hash Versioning spec (`2026-04-26-brief-hash-versioning`). This brief must run after brief 01 (canonical-json-and-hash) and before brief 02 (evidence-and-drift-integration). It has no dependency on brief 02.

## Intent

Extend the Zod schemas in `src/core/schemas/evidence.ts` to include `briefHash` on both `EvidenceTaskSchema` (per-entry) and `EvidenceLedgerSchema` (top-level). Also extend the `DriftReport` TypeScript type in `src/engine/orchestrator/drift.ts` with `briefHash`.

Add a test helper in the existing factory file and new test coverage for the regeneration scenario.

## Scope

**In bounds:**
- Modify `src/core/schemas/evidence.ts` — add `briefHash` to `EvidenceTaskSchema` and `EvidenceLedgerSchema`.
- Modify `src/engine/orchestrator/drift.ts` — add `briefHash` to the `DriftReport` type.
- Modify `testing/helpers/factories/task.ts` — add `makeBriefHash(tasks: Task[]): string` helper re-exporting from `src/core/brief-hash.ts`.
- Add test cases to `src/engine/orchestrator/evidence.test.ts` covering the regeneration scenario shape (schema-level only: does the parsed shape have the field?).
- Update `docs/TASK-CONTRACT.md` to document `briefHash` in the Evidence Ledger and Drift Report shape sections.

**Out of bounds:**
- Do not modify `src/core/schemas/task.ts` — `briefHash` is derived, not stored on `Task`.
- Do not modify callers in `evidence.ts`, `task-loop.ts`, `task-step.ts`, or `final-review.ts` — that is brief 02's job.
- Do not create new files beyond what is listed above.
- Do not add `briefHash` to `tasks.md` frontmatter or the `tasks.md` transport format.

## Code Context

### `src/core/schemas/evidence.ts` (current shape)

```ts
import { z } from 'zod';
import { TaskIdSchema } from './task.js';
import { TaskStatusSchema, TaskCompletionMethodSchema, WorkflowModeSchema } from './enums.js';

export const EvidenceTaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string(),
  file: z.string(),
  status: TaskStatusSchema,
  method: TaskCompletionMethodSchema.optional(),
  retries: z.number().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  changedFiles: z.array(z.string()),
  validation: z.array(EvidenceValidationEntrySchema),
  expectedEvidence: z.array(z.string()),
  observedEvidence: z.array(z.string()),
  escalated: z.boolean(),
});
// ... EvidenceLedgerSchema ...
export const EvidenceLedgerSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  feature: z.string(),
  mode: WorkflowModeSchema.optional(),
  generatedAt: z.string(),
  tasks: z.array(EvidenceTaskSchema),
  validationSummary: EvidenceValidationSummarySchema,
  finalReview: EvidenceFinalReviewSchema.optional(),
});
```

### `src/engine/orchestrator/drift.ts` (current `DriftReport` type)

```ts
export type DriftReport = {
  version: 1;
  passed: boolean;
  score: number;
  changedFiles: string[];
  expectedFiles: string[];
  findings: DriftFinding[];
};
```

### `testing/helpers/factories/task.ts` (current shape)

```ts
import type { Task } from '../../../src/core/schemas/task.js';
import { taskId as brand } from '../../../src/core/schemas/task.js';

type TaskOverrides = Omit<Partial<Task>, 'id' | 'dependsOn'> & {
  id?: string;
  dependsOn?: string[];
};

export function makeTask(overrides?: TaskOverrides): Task { ... }
```

The file has one export: `makeTask`. Add a second export `makeBriefHash` — do not change `makeTask`.

### `docs/TASK-CONTRACT.md` — sections to update

Two sections already exist and need a `briefHash` note appended:

1. **Evidence Ledger — Shape** (around line 260–283): Add `briefHash?: string | null` to both `EvidenceLedger` and the per-task entry shape.
2. **Deterministic Drift Report — Shape** (around line 326–343): Add `briefHash: string | null` to `DriftReport`.

## Implementation Plan

### 1. `src/core/schemas/evidence.ts`

Add `briefHash` to `EvidenceTaskSchema`:

```ts
export const EvidenceTaskSchema = z.object({
  // ... existing fields ...
  escalated: z.boolean(),
  briefHash: z.string().nullable().optional(),   // NEW — absent on legacy entries
});
```

Add `briefHash` to `EvidenceLedgerSchema`:

```ts
export const EvidenceLedgerSchema = z.object({
  // ... existing fields ...
  finalReview: EvidenceFinalReviewSchema.optional(),
  briefHash: z.string().nullable().optional(),   // NEW — absent on legacy ledgers
});
```

No other changes to `evidence.ts`.

### 2. `src/engine/orchestrator/drift.ts`

Add `briefHash` to the `DriftReport` type:

```ts
export type DriftReport = {
  version: 1;
  passed: boolean;
  score: number;
  changedFiles: string[];
  expectedFiles: string[];
  findings: DriftFinding[];
  briefHash: string | null | undefined;          // NEW — absent on legacy reports
};
```

No other changes to `drift.ts`. Brief 02 handles the `analyzeBriefDrift` function body.

### 3. `testing/helpers/factories/task.ts`

Add a second exported function:

```ts
import { hashTaskBrief } from '../../../src/core/brief-hash.js';

export function makeBriefHash(tasks?: Task[]): string {
  return hashTaskBrief(tasks ?? [makeTask()]);
}
```

This gives tests in brief 02 and brief 03 a one-call way to get a realistic hash without re-implementing hashing logic.

### 4. `docs/TASK-CONTRACT.md`

In the **Evidence Ledger — Shape** section, add `briefHash` to the TypeScript shape block for both `EvidenceLedger` and `EvidenceTask`. Add a one-line note: `briefHash` is absent on sessions written before this spec was implemented; readers must treat absent and `null` identically.

In the **Deterministic Drift Report — Shape** section, add `briefHash: string | null` to the `DriftReport` shape block with the same absent-equals-null note.

## Tests

### Schema-level tests — new file `src/core/schemas/evidence.test.ts`

The test file does not yet exist (check first: if it exists, add cases to it rather than creating a new one). Required cases:

- **Legacy parsing — absent `briefHash`:** parse a valid `EvidenceLedger` JSON without `briefHash`; assert `EvidenceLedgerSchema.safeParse(...)` succeeds.
- **Null `briefHash`:** parse a ledger with `briefHash: null`; assert it succeeds and `result.briefHash === null`.
- **String `briefHash`:** parse a ledger with `briefHash: 'abc123'`; assert it succeeds.
- **EvidenceTask: absent `briefHash`:** same three cases for individual task entries.

### Regeneration scenario test — add to `src/engine/orchestrator/evidence.test.ts`

Add one test that exercises the schema shape only (does not call `createEvidenceLedger` — that is brief 02). Construct a minimal `EvidenceLedger` literal with mixed `briefHash` values across tasks and parse it through `EvidenceLedgerSchema`:

```ts
const ledger = {
  version: 1,
  sessionId: 's1',
  feature: 'test',
  generatedAt: new Date().toISOString(),
  tasks: [
    { ...minimalTask('T001'), briefHash: 'hash-A' },
    { ...minimalTask('T002'), briefHash: 'hash-B' },  // regenerated mid-run
    { ...minimalTask('T003') },                        // legacy entry, no briefHash
  ],
  validationSummary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
};
const result = EvidenceLedgerSchema.safeParse(ledger);
assert(result.success);
assert(result.data.tasks[0].briefHash === 'hash-A');
assert(result.data.tasks[1].briefHash === 'hash-B');
assert(result.data.tasks[2].briefHash === undefined); // tolerated
```

### Existing tests that may be affected

`evidence.test.ts` and `drift.test.ts` already exist (they were created by the evidence-contract spec). Adding optional fields to schemas is non-breaking for Zod — existing parse calls will continue to succeed. No existing test assertions need changes.

Check `src/engine/orchestrator/drift.test.ts`: if any test constructs a `DriftReport` literal directly (not through `analyzeBriefDrift`), the new `briefHash` field must be added to that literal. Since it is `string | null | undefined`, any existing literal without `briefHash` will typecheck as before.

## Validation

```bash
npm test -- src/core/schemas/evidence.test.ts src/engine/orchestrator/evidence.test.ts
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
- `EvidenceTaskSchema` and `EvidenceLedgerSchema` must remain backwards-compatible: adding `.optional()` guarantees this for Zod parse calls.
- `testing/helpers/factories/task.ts` must not become a barrel — `makeTask` and `makeBriefHash` are both substantive exports, not re-exports.

## Escalation

Stop and report if:
- Brief 01 is not yet complete: `src/core/brief-hash.ts` does not exist. `npm run typecheck` will error when `makeBriefHash` is added to the factory. Return to the coordinator.
- `src/core/schemas/evidence.test.ts` already exists with conflicting test names: read the file first and add cases using distinct names.

## Evidence Requirements

After completion:
- `EvidenceLedgerSchema.safeParse({ version: 1, sessionId: 's', feature: 'f', generatedAt: 'now', tasks: [], validationSummary: { passed:0, failed:0, skipped:0, escalated:0 } })` succeeds (absent `briefHash` tolerated).
- `EvidenceLedgerSchema.parse({ ..., briefHash: null })` succeeds.
- `npm run typecheck` reports zero errors.
- `npm run lint` reports zero new warnings.
- `testing/helpers/factories/task.ts` exports exactly two functions: `makeTask` and `makeBriefHash`.

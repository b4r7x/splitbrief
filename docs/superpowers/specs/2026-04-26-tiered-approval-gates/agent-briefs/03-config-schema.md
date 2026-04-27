# 03 — Config Schema

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Agent: Config Schema implementer
Brief: 03 of 06 (Tiered Approval Gates spec)

## Intent

Extend `ConfigSchema` with an optional `approval` block covering tier policy, headless mode, and the planner-rejection-feed toggle. Define a separate `ApprovalsStoreSchema` for the runtime `.diptych/approvals.json` file. No source changes outside schema and schema tests.

## Scope

**In bounds:**
- `src/core/schemas/config.ts` — add `ApprovalConfigSchema`, extend `ConfigSchema`
- `src/core/schemas/approval-store.ts` (new file) — `ApprovalsStoreSchema`, `ApprovalGrantSchema`
- `src/core/schemas/config.test.ts` — extend or create if absent; test approval round-trips
- `src/core/schemas/approval-store.test.ts` (new file) — schema parse tests

**Out of bounds:**
- Do not touch any other schema file.
- Do not modify `src/core/schemas/evidence.ts` (brief 06 owns that).
- Do not modify `src/core/schemas/hooks.ts`.
- Do not write any orchestrator, TUI, or CLI code.

## Code Context

Read before implementing:

- `src/core/schemas/config.ts` — existing `ConfigSchema`, `version: 2 | 3` union, how optional sub-schemas are composed
- `src/core/schemas/enums.ts` — existing `z.enum` patterns
- `src/engine/orchestrator/action-classifier.ts` (from brief 01) — `ActionClass` type; re-export or import as needed

## Implementation Plan

### 1. Define `ApprovalGrantSchema` in `src/core/schemas/approval-store.ts`

```ts
import { z } from 'zod';

export const ActionClassSchema = z.enum([
  'read',
  'write_in_scope',
  'validation',
  'write_out_of_scope',
  'destructive',
  'network',
  'package_change',
]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const ApprovalGrantSchema = z.object({
  pattern: z.string().min(1),
  class: ActionClassSchema,
  scope: z.enum(['session', 'always']),
  sessionId: z.string().optional(),
  grantedAt: z.string(),    // ISO timestamp
});
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;

export const ApprovalsStoreSchema = z.object({
  version: z.literal(1),
  grants: z.array(ApprovalGrantSchema),
});
export type ApprovalsStore = z.infer<typeof ApprovalsStoreSchema>;
```

Note: `ActionClassSchema` and `ActionClass` are the canonical, Zod-validated definitions for this type. Brief 01 (`action-classifier.ts`) imports `ActionClass` from this file — `'../../core/schemas/approval-store.js'`. Do not let them diverge. If brief 01 is already merged with a local type definition, remove the local definition from `action-classifier.ts` and replace it with this import.

### 2. Define `ApprovalConfigSchema` in `src/core/schemas/config.ts`

Add before `ConfigSchema`:

```ts
export const ApprovalTierSchema = z.enum(['auto', 'sticky', 'confirm']);
export type ApprovalTier = z.infer<typeof ApprovalTierSchema>;

export const TierMapSchema = z.object({
  read: ApprovalTierSchema.optional(),
  write_in_scope: ApprovalTierSchema.optional(),
  validation: ApprovalTierSchema.optional(),
  write_out_of_scope: ApprovalTierSchema.optional(),
  destructive: ApprovalTierSchema.optional(),
  network: ApprovalTierSchema.optional(),
  package_change: ApprovalTierSchema.optional(),
});

export const ApprovalConfigSchema = z.object({
  enabled: z.boolean().default(true),
  headless: z.boolean().optional(),
  tiers: TierMapSchema.optional(),
  feedRejectionsToPlanner: z.boolean().default(true),
});
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;
```

### 3. Extend `ConfigSchema` with optional `approval` field

In the existing `ConfigSchema` object, add:

```ts
approval: ApprovalConfigSchema.optional(),
```

No change to `version` union. No migration needed.

### 4. Update import for `ActionClass` in `action-classifier.ts` (if necessary)

If `action-classifier.ts` was written with inline TypeScript type definitions, no change needed — `ApprovalGrantSchema` just happens to share the same string literals. Do not refactor `action-classifier.ts` to import from the schema file; keep the engine layer independent of the schema layer for this type (both use the same literals).

## Validation

### Tests (`src/core/schemas/config.test.ts`)

Cover at minimum (add to existing tests, or create file if absent):

- minimal config with no `approval` key parses successfully
- config with `approval: { enabled: true }` parses and returns defaults
- config with `approval.enabled: false` is preserved
- config with `approval.tiers: { write_out_of_scope: 'confirm' }` overrides tier
- config with `approval.headless: true` is preserved
- config with `approval.feedRejectionsToPlanner: false` is preserved
- invalid tier string in `tiers` map → parse error

### Tests (`src/core/schemas/approval-store.test.ts`)

Cover at minimum:

- empty grants array parses: `{ version: 1, grants: [] }`
- grant with `scope: 'session'` and `sessionId` parses
- grant with `scope: 'always'` and no `sessionId` parses
- missing `version` → parse error
- invalid `class` value → parse error
- invalid `scope` value → parse error

## Constraints

- No imports from `ink`, `react`, or any `src/features/` / `src/components/` path.
- Do not export a Zod `default()` for `ApprovalConfigSchema` at the schema level — the `.default(true)` on sub-fields is sufficient. The field itself is optional on `ConfigSchema`.
- Use `.strict()` on `ApprovalsStoreSchema` to catch unknown fields in the on-disk format and fail clearly.

## Escalation

If `src/core/schemas/config.test.ts` does not exist, create it with the tests above only. Do not rewrite existing config tests if the file exists.

## Evidence Requirements

- New file: `src/core/schemas/approval-store.ts`
- New file: `src/core/schemas/approval-store.test.ts`
- Modified: `src/core/schemas/config.ts`
- Modified (or created): `src/core/schemas/config.test.ts`
- All tests pass: `npm test -- src/core/schemas/`
- Typecheck clean: `npm run typecheck`

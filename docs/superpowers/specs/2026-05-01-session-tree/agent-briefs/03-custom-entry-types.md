# 03 - Custom Entry Types

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.
> Depends on: brief 01 (tree data model) must be implemented first.

## Goal

Create a typed entry registry for heterogeneous orchestration state. Each entry type has its own Zod payload schema, a factory function, and a `display` flag. Provide state reconstruction helpers that replay entries to derive current orchestration state.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Zod 4.x for all schemas.
- Tests must verify behavior, artifacts, or filesystem effects.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/core/sessions/tree/schemas.ts` — tree entry envelope (from brief 01)
- `src/core/sessions/tree/store.ts` — append/branch operations (from brief 01)
- `src/engine/events/types.ts` — `EngineEvent` pattern for typed variants
- `src/core/schemas/task.ts` — `TaskId`, `TaskSchema` pattern
- `src/core/schemas/recovery.ts` — `RecoveryIssue` pattern
- `docs/superpowers/specs/2026-05-01-session-tree/decisions.md` — ADR-005

## Write Ownership

Primary files:

```text
src/core/sessions/tree/entry-types.ts
src/core/sessions/tree/entry-types.test.ts
src/core/sessions/tree/registry.ts
src/core/sessions/tree/registry.test.ts
src/core/sessions/tree/reconstruct.ts
src/core/sessions/tree/reconstruct.test.ts
```

Do not edit tree store or I/O files beyond imports. Do not edit TUI files. Do not edit existing schema files.

## Entry Type Definitions

### Built-in Entry Types

Define Zod schemas for each payload type:

```typescript
// src/core/sessions/tree/entry-types.ts
import { z } from 'zod';
import { TaskIdSchema } from '../../schemas/task.js';
import { RecoveryReasonSchema, RecoveryActionSchema, PhaseSchema } from '../../schemas/enums.js';

/** Root entry, created once per tree. */
export const SessionStartPayloadSchema = z.object({
  feature: z.string(),
  mode: z.string().optional(),
  sessionId: z.string().optional(),
});
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;

/** A plan step derived from planner output. */
export const PlanStepPayloadSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  file: z.string(),
  action: z.enum(['create', 'modify']),
  description: z.string(),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type PlanStepPayload = z.infer<typeof PlanStepPayloadSchema>;

/** An implementer or planner invocation. */
export const AgentInvocationPayloadSchema = z.object({
  taskId: TaskIdSchema.optional(),
  role: z.enum(['planner', 'implementer', 'escalator']),
  tool: z.string(),
  model: z.string().optional(),
  phase: PhaseSchema,
  status: z.enum(['started', 'completed', 'failed']),
  durationMs: z.number().int().nonnegative().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type AgentInvocationPayload = z.infer<typeof AgentInvocationPayloadSchema>;

/** A recovery decision point. */
export const RecoveryDecisionPayloadSchema = z.object({
  issueId: z.string(),
  reason: RecoveryReasonSchema,
  taskId: TaskIdSchema.optional(),
  selectedAction: RecoveryActionSchema,
  availableActions: z.array(RecoveryActionSchema),
  message: z.string(),
  outcome: z.enum(['continued', 'retry-current-task', 'skipped-current-task', 'aborted', 'paused', 'blocked']).optional(),
});
export type RecoveryDecisionPayload = z.infer<typeof RecoveryDecisionPayloadSchema>;

/** A file state capture at a point in time. */
export const FileStatePayloadSchema = z.object({
  path: z.string(),
  action: z.enum(['created', 'modified', 'deleted']),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
  hash: z.string().optional(),
  taskId: TaskIdSchema.optional(),
});
export type FileStatePayload = z.infer<typeof FileStatePayloadSchema>;

/** A cost/token checkpoint. */
export const CostCheckpointPayloadSchema = z.object({
  totalCost: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  phase: PhaseSchema,
  taskId: TaskIdSchema.optional(),
  budgetRemaining: z.number().optional(),
});
export type CostCheckpointPayload = z.infer<typeof CostCheckpointPayloadSchema>;

/** A branch summary injected at the start of a retry branch. */
export const BranchSummaryPayloadSchema = z.object({
  goal: z.string(),
  progress: z.array(z.string()),
  decisions: z.array(z.string()),
  constraints: z.array(z.string()),
  nextSteps: z.array(z.string()),
  failureReason: z.string(),
  entryCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type BranchSummaryPayload = z.infer<typeof BranchSummaryPayloadSchema>;

/** All known entry type names as a const array. */
export const ENTRY_TYPES = [
  'session-start',
  'plan-step',
  'agent-invocation',
  'recovery-decision',
  'file-state',
  'cost-checkpoint',
  'branch-summary',
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
```

## Entry Type Registry

A runtime registry mapping type names to their Zod payload schemas:

```typescript
// src/core/sessions/tree/registry.ts
import { z } from 'zod';
import type { TreeEntryEnvelope, EntryId } from './schemas.js';
import {
  SessionStartPayloadSchema,
  PlanStepPayloadSchema,
  AgentInvocationPayloadSchema,
  RecoveryDecisionPayloadSchema,
  FileStatePayloadSchema,
  CostCheckpointPayloadSchema,
  BranchSummaryPayloadSchema,
  type EntryType,
} from './entry-types.js';

type PayloadSchema = z.ZodType<unknown>;

const registry = new Map<string, PayloadSchema>([
  ['session-start', SessionStartPayloadSchema],
  ['plan-step', PlanStepPayloadSchema],
  ['agent-invocation', AgentInvocationPayloadSchema],
  ['recovery-decision', RecoveryDecisionPayloadSchema],
  ['file-state', FileStatePayloadSchema],
  ['cost-checkpoint', CostCheckpointPayloadSchema],
  ['branch-summary', BranchSummaryPayloadSchema],
]);

/** Register a custom entry type at runtime. */
export function registerEntryType(type: string, schema: PayloadSchema): void {
  registry.set(type, schema);
}

/** Check if a type has a registered schema. */
export function hasEntryType(type: string): boolean {
  return registry.has(type);
}

/** Get the registered schema for a type. Returns undefined for unknown types. */
export function getEntrySchema(type: string): PayloadSchema | undefined {
  return registry.get(type);
}

export interface TypedEntry<T = unknown> {
  envelope: TreeEntryEnvelope;
  payload: T;
  valid: true;
}

export interface OpaqueEntry {
  envelope: TreeEntryEnvelope;
  payload: unknown;
  valid: false;
  type: string;
}

export type ParsedEntry = TypedEntry | OpaqueEntry;

/** Parse an entry envelope, validating payload against the registry. */
export function parseEntry(envelope: TreeEntryEnvelope): ParsedEntry {
  const schema = registry.get(envelope.type);
  if (!schema) {
    return { envelope, payload: envelope.payload, valid: false, type: envelope.type };
  }
  const result = schema.safeParse(envelope.payload);
  if (!result.success) {
    return { envelope, payload: envelope.payload, valid: false, type: envelope.type };
  }
  return { envelope, payload: result.data, valid: true };
}

/** Parse an entry and narrow to a specific known type. Returns null if type doesn't match. */
export function parseEntryAs<T>(envelope: TreeEntryEnvelope, expectedType: string, schema: z.ZodType<T>): TypedEntry<T> | null {
  if (envelope.type !== expectedType) return null;
  const result = schema.safeParse(envelope.payload);
  if (!result.success) return null;
  return { envelope, payload: result.data, valid: true };
}
```

## Entry Factories

Pure functions that construct `TreeEntryEnvelope` instances with validated payloads:

```typescript
// src/core/sessions/tree/entry-types.ts (continued)
import type { TreeEntryEnvelope, EntryId } from './schemas.js';
import { nextEntryId } from './schemas.js';

export interface EntryFactoryOptions {
  parentId: EntryId | null;
  entryCount: number;
  timestamp: number;
  display?: boolean;
}

export function createPlanStepEntry(payload: PlanStepPayload, opts: EntryFactoryOptions): TreeEntryEnvelope {
  return {
    id: nextEntryId(opts.entryCount),
    parentId: opts.parentId,
    type: 'plan-step',
    timestamp: opts.timestamp,
    payload: PlanStepPayloadSchema.parse(payload),
    display: opts.display ?? true,
  };
}

export function createAgentInvocationEntry(payload: AgentInvocationPayload, opts: EntryFactoryOptions): TreeEntryEnvelope {
  return {
    id: nextEntryId(opts.entryCount),
    parentId: opts.parentId,
    type: 'agent-invocation',
    timestamp: opts.timestamp,
    payload: AgentInvocationPayloadSchema.parse(payload),
    display: opts.display ?? false,
  };
}

export function createRecoveryDecisionEntry(payload: RecoveryDecisionPayload, opts: EntryFactoryOptions): TreeEntryEnvelope {
  return {
    id: nextEntryId(opts.entryCount),
    parentId: opts.parentId,
    type: 'recovery-decision',
    timestamp: opts.timestamp,
    payload: RecoveryDecisionPayloadSchema.parse(payload),
    display: opts.display ?? true,
  };
}

export function createFileStateEntry(payload: FileStatePayload, opts: EntryFactoryOptions): TreeEntryEnvelope {
  return {
    id: nextEntryId(opts.entryCount),
    parentId: opts.parentId,
    type: 'file-state',
    timestamp: opts.timestamp,
    payload: FileStatePayloadSchema.parse(payload),
    display: opts.display ?? false,
  };
}

export function createCostCheckpointEntry(payload: CostCheckpointPayload, opts: EntryFactoryOptions): TreeEntryEnvelope {
  return {
    id: nextEntryId(opts.entryCount),
    parentId: opts.parentId,
    type: 'cost-checkpoint',
    timestamp: opts.timestamp,
    payload: CostCheckpointPayloadSchema.parse(payload),
    display: opts.display ?? false,
  };
}
```

## State Reconstruction

Replay entries on the active path to derive current orchestration state:

```typescript
// src/core/sessions/tree/reconstruct.ts
import type { SessionTree } from './store.js';
import { activePath } from './store.js';
import { parseEntryAs } from './registry.js';
import {
  PlanStepPayloadSchema,
  AgentInvocationPayloadSchema,
  RecoveryDecisionPayloadSchema,
  FileStatePayloadSchema,
  CostCheckpointPayloadSchema,
  type PlanStepPayload,
  type AgentInvocationPayload,
  type RecoveryDecisionPayload,
  type FileStatePayload,
  type CostCheckpointPayload,
} from './entry-types.js';

export interface ReconstructedState {
  planSteps: PlanStepPayload[];
  agentInvocations: AgentInvocationPayload[];
  recoveryDecisions: RecoveryDecisionPayload[];
  fileStates: Map<string, FileStatePayload>;
  latestCostCheckpoint: CostCheckpointPayload | null;
  totalEntries: number;
}

/** Reconstruct orchestration state by replaying entries on the active path. */
export function reconstructState(tree: SessionTree): ReconstructedState {
  const path = activePath(tree);
  // Reverse to get root-first order for replay
  const rootFirst = [...path].reverse();

  const state: ReconstructedState = {
    planSteps: [],
    agentInvocations: [],
    recoveryDecisions: [],
    fileStates: new Map(),
    latestCostCheckpoint: null,
    totalEntries: rootFirst.length,
  };

  for (const envelope of rootFirst) {
    const planStep = parseEntryAs(envelope, 'plan-step', PlanStepPayloadSchema);
    if (planStep) {
      state.planSteps.push(planStep.payload);
      continue;
    }

    const invocation = parseEntryAs(envelope, 'agent-invocation', AgentInvocationPayloadSchema);
    if (invocation) {
      state.agentInvocations.push(invocation.payload);
      continue;
    }

    const recovery = parseEntryAs(envelope, 'recovery-decision', RecoveryDecisionPayloadSchema);
    if (recovery) {
      state.recoveryDecisions.push(recovery.payload);
      continue;
    }

    const fileState = parseEntryAs(envelope, 'file-state', FileStatePayloadSchema);
    if (fileState) {
      // Latest state per file wins
      state.fileStates.set(fileState.payload.path, fileState.payload);
      continue;
    }

    const cost = parseEntryAs(envelope, 'cost-checkpoint', CostCheckpointPayloadSchema);
    if (cost) {
      state.latestCostCheckpoint = cost.payload;
      continue;
    }
  }

  return state;
}

/** Get entries of a specific type from the active path. */
export function entriesOfType<T>(tree: SessionTree, type: string, schema: z.ZodType<T>): T[] {
  const path = activePath(tree);
  const results: T[] = [];
  for (const envelope of path) {
    const parsed = parseEntryAs(envelope, type, schema);
    if (parsed) results.push(parsed.payload);
  }
  return results;
}

/** Get all displayable entries from the active path (where display !== false). */
export function displayableEntries(tree: SessionTree): import('./schemas.js').TreeEntryEnvelope[] {
  const path = activePath(tree);
  return path.filter(e => e.display !== false);
}
```

## Tests

### Entry types tests (`entry-types.test.ts`)

- Each payload schema accepts a valid payload.
- Each payload schema rejects payload with missing required fields.
- `createPlanStepEntry` produces valid envelope with correct type and validated payload.
- `createAgentInvocationEntry` defaults `display` to `false`.
- `createRecoveryDecisionEntry` defaults `display` to `true`.
- `createFileStateEntry` defaults `display` to `false`.
- `createCostCheckpointEntry` defaults `display` to `false`.
- Factory functions increment entry IDs correctly.
- Factory functions validate payload (throw on invalid input).

### Registry tests (`registry.test.ts`)

- `parseEntry` with known type and valid payload returns `{ valid: true }` with typed payload.
- `parseEntry` with known type and invalid payload returns `{ valid: false }`.
- `parseEntry` with unknown type returns `{ valid: false }` (opaque entry preserved).
- `registerEntryType` adds new type, subsequent `parseEntry` validates against it.
- `hasEntryType` returns true for registered, false for unknown.
- `parseEntryAs` returns typed result for matching type, null for non-matching.

### Reconstruct tests (`reconstruct.test.ts`)

- `reconstructState` on empty tree (root only) returns empty collections.
- `reconstructState` on linear path collects all typed entries.
- `reconstructState` for file-state uses latest state per path.
- `reconstructState` after branch only includes active-path entries, not abandoned branch.
- `entriesOfType` filters correctly by type.
- `displayableEntries` excludes entries with `display: false`.
- `displayableEntries` includes entries with `display: true` or `display: undefined`.

## Validation Commands

```bash
npm test -- src/core/sessions/tree/entry-types.test.ts
npm test -- src/core/sessions/tree/registry.test.ts
npm test -- src/core/sessions/tree/reconstruct.test.ts
npm run typecheck
npm run lint
```

## Non-Goals

- No TUI rendering in this brief.
- No integration with engine event bus (that's future plumbing).
- No migration of existing session log entries.
- No persistence changes (uses store/io from brief 01).

## Expected Final Report

Report:

- files changed
- entry types implemented with their schemas
- registry behavior verified
- state reconstruction tested (including branching scenarios)
- validation commands run and results
- risks or follow-ups for downstream briefs

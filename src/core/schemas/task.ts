/**
 * Task schema.
 *
 * This shape is documented as a **stable contract** in `docs/TASK-CONTRACT.md`.
 * External tools (Kanban viewers, Jira exporters, custom UIs) rely on it.
 * Breaking changes require a `stateVersion` bump.
 *
 * The schema is the persisted transport for **Product Task Brief v1**, whose
 * 9 semantic sections are: Identity, Intent, Scope, Code Context,
 * Implementation Plan, Validation, Constraints, Escalation, and Evidence.
 * Field-to-section mapping lives in `docs/TASK-CONTRACT.md`.
 *
 * When adding fields: prefer optional fields so old consumers keep working.
 * When renaming or changing types: bump `stateVersion` in `src/core/state/machine.ts`
 * and add a migration entry to `CHANGELOG.md`.
 *
 * @see docs/TASK-CONTRACT.md
 */
import { z } from 'zod';
import { FileActionSchema, TaskStatusSchema } from './enums.js';

export const TaskIdSchema = z
  .string()
  .regex(/^T\d{3}$/)
  .brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;
export const taskId = (s: string): TaskId => TaskIdSchema.parse(s);

export function isTaskCompleted(status: Task['status']): boolean {
  return status === 'done' || status === 'escalated';
}

export function formatTaskId(n: number): TaskId {
  return taskId(`T${String(n).padStart(3, '0')}`);
}

/** test: a test file or pattern; cmd: a command; render: a gallery scenario id. */
export const CheckSchema = z.object({
  id: z.string(),
  kind: z.enum(['test', 'cmd', 'render']),
  value: z.string(),
  required: z.boolean(),
});
export type Check = z.infer<typeof CheckSchema>;

export const CheckResultSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** `write` only: the protected-path confirmation matches `write <path>` (`gateChangedFiles`). */
export const ProtectedOperationSchema = z.object({
  path: z.string(),
  operation: z.literal('write'),
});

/** A brief saved before `suggestedFiles` named its writes in `file` and `files`. */
function foldSavedFiles(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || 'suggestedFiles' in value) return value;
  if ('files' in value && Array.isArray(value.files) && value.files.length > 0) {
    return { ...value, suggestedFiles: value.files };
  }
  return { ...value, suggestedFiles: 'file' in value ? [value.file] : [] };
}

export const TaskSchema = z.preprocess(
  foldSavedFiles,
  z.object({
    /** Branded string ID in `TNNN` format. Stable for the lifetime of the session. @see docs/TASK-CONTRACT.md */
    id: TaskIdSchema,
    parentId: TaskIdSchema.optional(),
    /** Short human-readable label. */
    title: z.string(),
    /** `create` if the file does not yet exist; `modify` if it does. */
    action: FileActionSchema,
    /** Every path this brief may write, first the anchor. One file is the XS slice. */
    suggestedFiles: z.tuple([z.string()], z.string()),
    /** Captured current code of the non-anchor `files` at task start, keyed by path. */
    currentCodeByFile: z.record(z.string(), z.string()).optional(),
    /** IDs of tasks that must reach a terminal state before this task may start. */
    dependsOn: z.array(TaskIdSchema),
    /** Full prose description of what the implementer must do. */
    description: z.string(),
    /** Optional function/interface signature hint for the implementer. */
    signature: z.string().optional(),
    /** Captured existing code at task start, used as context for modify tasks. */
    currentCode: z.string().optional(),
    /** Test cases / acceptance criteria. Each entry is a verifiable statement. */
    tests: z.array(z.string()),
    /** Additional constraints or requirements the implementation must satisfy. */
    constraints: z.array(z.string()),
    /** Optional code pattern hint (e.g. a relevant snippet from the codebase). */
    pattern: z.string().optional(),
    /** Language-specific type declarations, interfaces, or data shapes relevant to this task. */
    typeDefs: z.string(),
    /** Ordered list of implementation steps for the implementer to follow. */
    implementationSteps: z.array(z.string()),
    /**
     * Optional Task Brief v1 §Scope: explicit in-bounds / out-of-bounds notes
     * carried alongside the prose `description`. Older briefs may omit it.
     */
    scope: z
      .object({
        inBounds: z.array(z.string()).optional(),
        outOfBounds: z.array(z.string()).optional(),
        approvedOutOfBounds: z.array(z.string()).optional(),
      })
      .optional(),
    /**
     * Optional Task Brief v1 §Escalation: refusal/escalation conditions where the
     * implementer must stop and ask instead of guessing.
     */
    escalation: z.array(z.string()).optional(),
    /**
     * Optional Task Brief v1 §Evidence: the final reviewable proof the workflow
     * should preserve once the task is done.
     */
    evidence: z.array(z.string()).optional(),
    /** Current task status. @see docs/TASK-CONTRACT.md §TaskStatus */
    status: TaskStatusSchema,
    /** Ids of the plan criteria this task serves. */
    criteria: z.array(z.string()).optional(),
    /** Focused checks that verify this task. */
    checks: z.array(CheckSchema).optional(),
    checkResults: z.array(CheckResultSchema).optional(),
    /** Read-only context; SPLITBRIEF attaches their current code at dispatch. */
    contextFiles: z.array(z.string()).optional(),
    /** Captured current code of `contextFiles`, keyed by path. Never a write target. */
    contextCodeByFile: z.record(z.string(), z.string()).optional(),
    /** Explicit "do not" notes. */
    exclusions: z.array(z.string()).optional(),
    /** Absent means batch 1. */
    batch: z.number().int().min(1).optional(),
    /** Protected writes the approved plan confirms in advance. */
    protectedOperations: z.array(ProtectedOperationSchema).optional(),
    revision: z.number().int().min(1).optional(),
    /** Content hashes of the input files of this revision, keyed by path. */
    inputHashes: z.record(z.string(), z.string()).optional(),
    fix: z
      .object({
        cycle: z.number().int().min(1),
        findings: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            acceptance: z.string().nullable(),
            /** The red this finding answers; the brief gate runs its checks again, each reviewer check by `commands[id]`. */
            file: z.string().optional(),
            checkIds: z.array(z.string()).optional(),
            commands: z.record(z.string(), z.string()).optional(),
            output: z.string().optional(),
          }),
        ),
      })
      .optional(),
  }),
);

export type Task = z.infer<typeof TaskSchema>;

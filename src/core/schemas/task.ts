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

export const TaskSchema = z.object({
  /** Branded string ID in `TNNN` format. Stable for the lifetime of the session. @see docs/TASK-CONTRACT.md */
  id: TaskIdSchema,
  /** Short human-readable label. */
  title: z.string(),
  /** `create` if the file does not yet exist; `modify` if it does. */
  action: FileActionSchema,
  /** Project-relative path, e.g. `src/features/auth/SignupForm.tsx`. */
  file: z.string(),
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
});

export type Task = z.infer<typeof TaskSchema>;

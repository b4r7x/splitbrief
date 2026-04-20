/**
 * Task schema.
 *
 * This shape is documented as a **stable contract** in `docs/TASK-CONTRACT.md`.
 * External tools (Kanban viewers, Jira exporters, custom UIs) rely on it.
 * Breaking changes require a `stateVersion` bump.
 *
 * When adding fields: prefer optional fields so old consumers keep working.
 * When renaming or changing types: bump `stateVersion` in `src/core/state/machine.ts`
 * and add a migration entry to `CHANGELOG.md`.
 *
 * @see docs/TASK-CONTRACT.md
 */
import { z } from 'zod';
import { TaskStatusSchema } from './enums.js';

export const TaskIdSchema = z.string().brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;
export const taskId = (s: string): TaskId => TaskIdSchema.parse(s);

export const TaskSchema = z.object({
  /** Branded string ID in `T-NNN` format. Stable for the lifetime of the session. @see docs/TASK-CONTRACT.md */
  id: TaskIdSchema,
  /** Short human-readable label. */
  title: z.string(),
  /** `create` if the file does not yet exist; `modify` if it does. */
  action: z.enum(['create', 'modify']),
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
  /** TypeScript type definitions / interface declarations relevant to this task. */
  typeDefs: z.string(),
  /** Ordered list of implementation steps for the implementer to follow. */
  implementationSteps: z.array(z.string()),
  /** Current task status. @see docs/TASK-CONTRACT.md §TaskStatus */
  status: TaskStatusSchema,
});

export type Task = z.infer<typeof TaskSchema>;

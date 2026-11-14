import type { ConsultReason, ImplementerReport } from '../../../../core/schemas/consult.js';
import type { Plan } from '../../../../core/schemas/plan.js';
import type { ImplementerWriteMode } from '../../../../core/schemas/runner/implementer.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { ConsultRecord } from '../../../../core/schemas/workflow/consult-record.js';
import type { AttemptFailure } from '../../../../core/schemas/workflow/lineage.js';

export type ConsultPromptInput = Readonly<{
  workspaceDir: string;
  reason: ConsultReason;
  /** The run's plan: the criteria and checks every task serves. */
  plan: Plan | undefined;
  task: Task;
  /** The task's earlier revisions, oldest first; the current task travels as `task`. */
  revisions: readonly Task[];
  /**
   * The task's change from its start to now: every attempt, revision and split subtask of its
   * lineage. `diffs` holds one entry per changed file of the brief, `otherFiles` names every
   * other changed file. Null when no start is recorded.
   */
  taskDiff: Readonly<{
    diffs: readonly { path: string; diff: string }[];
    otherFiles: readonly string[];
  }> | null;
  /** The lineage's failed attempts, oldest first, each with its first error line. */
  failedAttempts: readonly AttemptFailure[];
  failingOutput: string;
  report: ImplementerReport | null;
  /** The answers earlier consults of this lineage gave. */
  earlierConsults: readonly ConsultRecord[];
  /** Every task of the run except the one being consulted about. */
  otherTasks: readonly Task[];
  /**
   * The brief's operator-instruction log, oldest first: every correction the user sent this
   * brief, by queue, mid-call or on resume, and every answer to a question about it.
   */
  operatorInstructions: readonly string[];
  /** How the default implementer writes files: a rewrite or a split is written for it. */
  writesFiles: ImplementerWriteMode;
  /**
   * The planner's session already holds this run's plan and brief, so the new attempt's evidence
   * goes as a short turn instead of the whole prompt. A fix task's repair consult never sets it:
   * the review wrote that brief, and the planner reads it whole.
   */
  resumed?: boolean | undefined;
}>;

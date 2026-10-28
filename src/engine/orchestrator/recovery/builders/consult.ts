import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { FailureMark } from '../../../../core/schemas/workflow.js';
import { noProgressCause } from '../../../../core/recovery/headline.js';
import type { ProgressStop } from '../../../../core/state/progress.js';
import { haltActions } from './actions.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';
import { taskFiles } from './details.js';

const SHOWN_KEYS = 3;

export interface NoProgressRecoveryOptions extends RecoveryBuilderBase {
  phase: Phase;
  task: Task;
  stop: ProgressStop;
  /** The failure the last attempt left. */
  failure: FailureMark;
  /** The planner answers the lineage got. */
  answers: number;
  /** The diagnosis of the lineage's last planner answer. */
  lastDiagnosis: string;
  failingOutput?: string | undefined;
  attempts?: number | undefined;
}

function failureLine(failure: FailureMark): string {
  const parts = failure.map(({ source, keys }) => {
    if (keys.length === 0) return source;
    const more = keys.length > SHOWN_KEYS ? ` (+${keys.length - SHOWN_KEYS} more)` : '';
    return `${source}: ${keys.slice(0, SHOWN_KEYS).join(', ')}${more}`;
  });
  return `Failure: ${parts.join('; ')}`;
}

/**
 * The planner's answers did not move the brief's failure two times in a row, or the brief
 * used all its answers. The failure and the last diagnosis travel in the details so the
 * operator decides on the evidence.
 */
export function buildNoProgressRecoveryIssue(opts: NoProgressRecoveryOptions): RecoveryIssue {
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'no-progress',
    phase: opts.phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: noProgressCause(opts.task.id, opts.stop, opts.answers),
    details: [
      failureLine(opts.failure),
      `Last diagnosis: ${opts.lastDiagnosis}`,
      "Continuing asks the planner again, starting from the last attempt's files.",
    ],
    facts: compactFacts({
      lastDiagnosis: opts.lastDiagnosis,
      failingOutput: opts.failingOutput,
      answers: opts.answers,
      stop: opts.stop,
    }),
    availableActions: haltActions('no-progress', ['continue', 'skip-current-task', 'end-run']),
    recommendedAction: 'continue',
    ...(opts.attempts !== undefined && { attempts: opts.attempts }),
    createdAt: opts.createdAt,
  });
}

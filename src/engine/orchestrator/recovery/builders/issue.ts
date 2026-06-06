import type { Phase, RecoveryAction, RecoveryReason } from '../../../../core/schemas/enums.js';
import type { RecoveryFact, RecoveryIssue } from '../../../../core/schemas/recovery.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import { uniqueSortedIds, uniqueSorted } from '../../../../utils/collections.js';

export const MAX_SUMMARY_LENGTH = 320;

export interface RecoveryBuilderBase {
  createdAt: string;
  id?: string | undefined;
}

export interface TaskRecoveryContext {
  task: Task;
  phase?: Phase | undefined;
  attempts?: number | undefined;
  maxAttempts?: number | undefined;
  selectedImplementerProfile?: string | undefined;
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}

export function summarizeText(input: string): string {
  const normalized = input.trim().replace(/\s+/g, ' ');
  if (normalized.length <= MAX_SUMMARY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

export function buildRecoveryIssueId(opts: {
  reason: RecoveryReason;
  phase: Phase;
  taskId?: TaskId | undefined;
  createdAt: string;
}): string {
  const stamp = opts.createdAt.replace(/\D/g, '').slice(0, 14) || 'unknown';
  const reason = opts.reason.replaceAll('-', '_');
  const phase = opts.phase.replaceAll('-', '_');
  const task = opts.taskId ? `_${opts.taskId}` : '';
  return `rec_${stamp}_${reason}_${phase}${task}`;
}

export function createRecoveryIssue(opts: {
  id?: string | undefined;
  reason: RecoveryReason;
  phase: Phase;
  task?: Task | undefined;
  files: string[];
  affectedTaskIds: TaskId[];
  message: string;
  details: string[];
  attempts?: number | undefined;
  maxAttempts?: number | undefined;
  selectedImplementerProfile?: string | undefined;
  facts?: Record<string, RecoveryFact> | undefined;
  availableActions: RecoveryAction[];
  recommendedAction: RecoveryAction;
  createdAt: string;
}): RecoveryIssue {
  const issue: RecoveryIssue = {
    id:
      opts.id ??
      buildRecoveryIssueId({
        reason: opts.reason,
        phase: opts.phase,
        taskId: opts.task?.id,
        createdAt: opts.createdAt,
      }),
    reason: opts.reason,
    phase: opts.phase,
    status: 'awaiting-user',
    ...(opts.task ? { taskId: opts.task.id, taskTitle: opts.task.title } : {}),
    files: uniqueSorted(opts.files, { trim: true, nonEmpty: true }),
    affectedTaskIds: uniqueSortedIds(opts.affectedTaskIds),
    message: opts.message,
    details: opts.details.map(summarizeText).filter((detail) => detail.length > 0),
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.selectedImplementerProfile !== undefined
      ? { selectedImplementerProfile: opts.selectedImplementerProfile }
      : {}),
    ...(opts.facts !== undefined && Object.keys(opts.facts).length > 0
      ? { facts: opts.facts }
      : {}),
    availableActions: opts.availableActions,
    recommendedAction: opts.recommendedAction,
    createdAt: opts.createdAt,
  };
  return issue;
}

export function compactFacts(
  values: Record<string, RecoveryFact | undefined>,
): Record<string, RecoveryFact> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, RecoveryFact] => entry[1] !== undefined,
    ),
  );
}

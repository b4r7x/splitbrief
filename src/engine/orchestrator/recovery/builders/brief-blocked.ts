import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import { uniqueSortedIds, uniqueSorted } from '../../../../utils/collections.js';
import { haltActions, chooseRecommended } from './actions.js';
import { taskFiles } from './details.js';
import {
  type RecoveryBuilderBase,
  type TaskRecoveryContext,
  createRecoveryIssue,
  compactFacts,
} from './issue.js';

export interface ImplementerUnavailableRecoveryOptions
  extends RecoveryBuilderBase,
    TaskRecoveryContext {
  tool?: string | undefined;
  model?: string | undefined;
  availabilityReason?: string | undefined;
}

export interface DependencyBlockedRecoveryOptions extends RecoveryBuilderBase {
  task: Task;
  blockedByTasks?: Task[] | undefined;
  blockedByTaskIds?: TaskId[] | undefined;
  phase?: Phase | undefined;
}

export function buildImplementerUnavailableRecoveryIssue(
  opts: ImplementerUnavailableRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const actions = haltActions('implementation-error', [
    'retry-same-worker',
    'skip-current-task',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'implementation-error',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} selected implementer is unavailable`,
    details: [
      opts.tool !== undefined ? `Tool: ${opts.tool}` : undefined,
      opts.model !== undefined ? `Model: ${opts.model}` : undefined,
      opts.availabilityReason !== undefined
        ? `Availability: ${opts.availabilityReason}`
        : undefined,
    ].filter((detail): detail is string => detail !== undefined),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      tool: opts.tool,
      model: opts.model,
      availabilityReason: opts.availabilityReason,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

function dependencyDetail(blockedByTaskIds: TaskId[], blockedByTasks: Task[]): string {
  if (blockedByTasks.length > 0) {
    const formatted = blockedByTasks.map((task) => `${task.id} (${task.status})`).join(', ');
    return `Blocked dependencies: ${formatted}`;
  }
  if (blockedByTaskIds.length > 0) {
    return `Blocked dependencies: ${blockedByTaskIds.join(', ')}`;
  }
  return 'Blocked dependency was not identified.';
}

export function buildDependencyBlockedRecoveryIssue(
  opts: DependencyBlockedRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const blockedByTaskIds = uniqueSortedIds([
    ...(opts.blockedByTaskIds ?? []),
    ...(opts.blockedByTasks ?? []).map((task) => task.id),
  ]);
  const affectedTaskIds = uniqueSortedIds([opts.task.id, ...blockedByTaskIds]);
  const actions = haltActions('dependency-blocked', ['skip-current-task', 'end-run']);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'dependency-blocked',
    phase,
    task: opts.task,
    files: uniqueSorted([opts.task, ...(opts.blockedByTasks ?? [])].flatMap(taskFiles)),
    affectedTaskIds,
    message: `${opts.task.id} is blocked by dependency status`,
    details: [dependencyDetail(blockedByTaskIds, opts.blockedByTasks ?? [])],
    facts: compactFacts({
      blockedByTaskIds: blockedByTaskIds.join(', '),
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

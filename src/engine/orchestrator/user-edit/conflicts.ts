import type { Task, TaskId } from '../../../core/schemas/task.js';
import { uniqueSortedIds, uniqueSorted } from '../../../utils/collections.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';

import type { UserEditConflictKind, UserEditConflictAction } from '../../../core/schemas/enums.js';
import type { UserEditConflictFile, UserEditConflict } from '../../events/workflow-events.js';

export const DESTRUCTIVE_CONFLICT_ACTIONS: readonly UserEditConflictAction[] = [
  'pause',
  'skip-current-task',
  'abort-workflow',
];

function fileMatchesTask(file: string, task: Task): boolean {
  return isInDeclaredSet(file, taskDeclaredPatterns(task));
}

function classifyFile(opts: {
  file: string;
  currentTask: Task;
  currentTaskInFlight: boolean;
  allTasks: Task[];
  currentTaskIndex: number;
}): UserEditConflictFile {
  const { file, currentTask, currentTaskInFlight, allTasks, currentTaskIndex } = opts;

  if (fileMatchesTask(file, currentTask)) {
    // A brief in flight has output to lose; a brief that has not started takes the edit as its
    // starting point, the same stale compiled input as for any later brief.
    const kind = currentTaskInFlight ? 'current-task-conflict' : 'future-task-stale-input';
    return { file, kind, affectedTaskIds: [currentTask.id] };
  }

  const dependencyTaskIds = new Set(currentTask.dependsOn);
  const dependencyTasks = allTasks.filter((task) => dependencyTaskIds.has(task.id));
  const affectedDependencies = dependencyTasks.filter((task) => fileMatchesTask(file, task));
  if (affectedDependencies.length > 0) {
    // A dependency that finished hands the edited bytes on as input, the same as a later brief;
    // one that has not, or a brief already running on the old bytes, still conflicts.
    const inputOnly =
      !currentTaskInFlight && affectedDependencies.every((task) => task.status === 'done');
    return {
      file,
      kind: inputOnly ? 'future-task-stale-input' : 'dependency-file-conflict',
      affectedTaskIds: uniqueSortedIds(affectedDependencies.map((task) => task.id)),
    };
  }

  const affectedFutureTasks = allTasks
    .slice(currentTaskIndex + 1)
    .filter((task) => fileMatchesTask(file, task))
    .map((task) => task.id);
  if (affectedFutureTasks.length > 0) {
    return {
      file,
      kind: 'future-task-stale-input',
      affectedTaskIds: uniqueSortedIds(affectedFutureTasks),
    };
  }

  return { file, kind: 'unrelated', affectedTaskIds: [] };
}

function dominantKind(fileConflicts: UserEditConflictFile[]): UserEditConflictKind {
  const kinds = fileConflicts.map((conflict) => conflict.kind);
  if (kinds.includes('current-task-conflict')) return 'current-task-conflict';
  if (kinds.includes('dependency-file-conflict')) return 'dependency-file-conflict';
  if (kinds.includes('changed-during-approval-promotion'))
    return 'changed-during-approval-promotion';
  if (kinds.includes('future-task-stale-input')) return 'future-task-stale-input';
  return 'unrelated';
}

function actionsFor(kind: UserEditConflictKind): UserEditConflictAction[] {
  if (kind === 'unrelated' || kind === 'future-task-stale-input') {
    return ['continue-unrelated', 'pause', 'abort-workflow'];
  }
  return [...DESTRUCTIVE_CONFLICT_ACTIONS];
}

/**
 * `currentTaskInFlight` is the caller's own answer, never read off `currentTask.status`: the task
 * object a caller holds mid-brief is a copy taken before `START_TASK` and still says `pending`.
 */
export function classifyUserEditConflict(opts: {
  files: string[];
  currentTask: Task;
  currentTaskInFlight: boolean;
  allTasks: Task[];
  currentTaskIndex: number;
}): UserEditConflict {
  const files = uniqueSorted(opts.files, { nonEmpty: true });
  const fileConflicts = files.map((file) => classifyFile({ ...opts, file }));
  const kind = dominantKind(fileConflicts);
  const affectedTaskIds = uniqueSortedIds(
    fileConflicts.flatMap((conflict) => conflict.affectedTaskIds),
  );
  const safeToContinue = kind === 'unrelated' || kind === 'future-task-stale-input';

  return {
    kind,
    files,
    affectedTaskIds,
    currentTaskId: opts.currentTask.id,
    fileConflicts,
    safeToContinue,
    availableActions: actionsFor(kind),
  };
}

export function createApprovalPromotionConflict(opts: {
  files: string[];
  currentTaskId?: TaskId;
}): UserEditConflict {
  const files = uniqueSorted(opts.files, { nonEmpty: true });
  const affectedTaskIds = opts.currentTaskId ? [opts.currentTaskId] : [];
  return {
    kind: 'changed-during-approval-promotion',
    files,
    affectedTaskIds,
    ...(opts.currentTaskId !== undefined && { currentTaskId: opts.currentTaskId }),
    fileConflicts: files.map((file) => ({
      file,
      kind: 'changed-during-approval-promotion',
      affectedTaskIds,
    })),
    safeToContinue: false,
    availableActions: [...DESTRUCTIVE_CONFLICT_ACTIONS],
  };
}

export function normalizeUserEditConflictAction(
  conflict: UserEditConflict,
  selectedAction: UserEditConflictAction,
  fallback: UserEditConflictAction = 'pause',
): UserEditConflictAction {
  if (conflict.availableActions.includes(selectedAction)) return selectedAction;
  if (conflict.availableActions.includes(fallback)) return fallback;
  return conflict.availableActions[0] ?? 'pause';
}

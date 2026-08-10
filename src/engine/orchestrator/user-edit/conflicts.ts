import type { Task, TaskId } from '../../../core/schemas/task.js';
import { uniqueSortedIds, uniqueSorted } from '../../../utils/collections.js';
import { matchesActionPattern } from '../approval/action-classifier.js';
import { taskAcceptedPatterns } from '../task-scope.js';

import type { UserEditConflictKind, UserEditConflictAction } from '../../../core/schemas/enums.js';
import type { UserEditConflictFile, UserEditConflict } from '../../events/workflow-events.js';

export const DESTRUCTIVE_CONFLICT_ACTIONS: readonly UserEditConflictAction[] = [
  'pause',
  'skip-current-task',
  'abort-workflow',
];

function fileMatchesTask(file: string, task: Task): boolean {
  return taskAcceptedPatterns(task).some((pattern) => matchesActionPattern(file, pattern));
}

function classifyFile(opts: {
  file: string;
  currentTask: Task;
  allTasks: Task[];
  currentTaskIndex: number;
}): UserEditConflictFile {
  const { file, currentTask, allTasks, currentTaskIndex } = opts;

  if (fileMatchesTask(file, currentTask)) {
    return { file, kind: 'current-task-conflict', affectedTaskIds: [currentTask.id] };
  }

  const dependencyTaskIds = new Set(currentTask.dependsOn);
  const dependencyTasks = allTasks.filter((task) => dependencyTaskIds.has(task.id));
  const affectedDependencies = dependencyTasks
    .filter((task) => fileMatchesTask(file, task))
    .map((task) => task.id);
  if (affectedDependencies.length > 0) {
    return {
      file,
      kind: 'dependency-file-conflict',
      affectedTaskIds: uniqueSortedIds(affectedDependencies),
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

export function classifyUserEditConflict(opts: {
  files: string[];
  currentTask: Task;
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

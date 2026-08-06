import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { UserEditConflictAction } from '../../../core/schemas/enums.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { changedFilesSinceBaseline, type ChangedFilesBaseline } from '../changed-files-baseline.js';
import { classifyUserEditConflict, normalizeUserEditConflictAction } from './conflicts.js';
import { publishUserEditConflict, publishWarningFromError } from '../events.js';
import { nowIso } from '../../../utils/format-time.js';
import { raisePendingRecovery } from '../state-ops.js';
import { buildUserEditConflictRecoveryIssue } from '../recovery/builders/workflow.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';

export async function checkUserEditConflicts(opts: {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  task: Task;
  taskIndex: number;
  baseline: ChangedFilesBaseline;
  acknowledgedUserEditFiles: Set<string>;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; stopped: boolean }> {
  const {
    projectDir,
    sessionId,
    callbacks,
    bus,
    task,
    taskIndex,
    baseline,
    acknowledgedUserEditFiles,
    setTrackedState,
  } = opts;
  const { state } = opts;
  const scope = { projectDir, sessionId, bus };

  let changedFiles: string[];
  try {
    changedFiles = await changedFilesSinceBaseline(projectDir, baseline);
  } catch (err) {
    publishWarningFromError(
      { bus, phase: state.phase },
      'Failed to check user edit conflicts',
      err,
    );
    return { state, stopped: false };
  }
  if (changedFiles.length === 0) return { state, stopped: false };

  const conflict = classifyUserEditConflict({
    files: changedFiles,
    currentTask: task,
    allTasks: state.tasks,
    currentTaskIndex: taskIndex,
  });

  if (conflict.kind === 'unrelated') {
    for (const fileConflict of conflict.fileConflicts) {
      acknowledgedUserEditFiles.add(fileConflict.file);
    }
    publishUserEditConflict({ bus: bus, phase: state.phase }, conflict, 'continue-unrelated');
    return { state, stopped: false };
  }

  let selectedAction: UserEditConflictAction;
  if (conflict.safeToContinue) {
    if (callbacks.onUserEditConflict) {
      try {
        selectedAction = normalizeUserEditConflictAction(
          conflict,
          await callbacks.onUserEditConflict(conflict),
          'continue-unrelated',
        );
      } catch {
        selectedAction = 'pause';
      }
    } else {
      selectedAction = normalizeUserEditConflictAction(
        conflict,
        'continue-unrelated',
        'continue-unrelated',
      );
    }
  } else {
    selectedAction = 'pause';
  }
  publishUserEditConflict({ bus: bus, phase: state.phase }, conflict, selectedAction);

  if (selectedAction === 'continue-unrelated' && conflict.safeToContinue) {
    for (const fileConflict of conflict.fileConflicts) {
      if (fileConflict.kind === 'unrelated' || fileConflict.kind === 'future-task-stale-input') {
        acknowledgedUserEditFiles.add(fileConflict.file);
      }
    }
    return { state, stopped: false };
  }

  const issue = buildUserEditConflictRecoveryIssue({
    conflict,
    currentTask: task,
    phase: state.phase,
    createdAt: nowIso(),
  });
  return { state: raisePendingRecovery(scope, state, issue, setTrackedState), stopped: true };
}

export async function detectValidationFailureUserEdit(opts: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
  task: Task;
  taskIndex: number;
  taskChangedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; diverted: boolean }> {
  const { projectDir, sessionId, bus, task, taskIndex, taskChangedFiles, setTrackedState } = opts;
  const { state } = opts;

  let failingUniverse: string[];
  try {
    failingUniverse = await getChangedFilesSinceSnapshot(projectDir, opts.taskStartSnapshot);
  } catch (err) {
    publishWarningFromError(
      { bus, phase: state.phase },
      'Failed to inspect validation-failure changed files',
      err,
    );
    return { state, diverted: false };
  }

  const attributed = new Set(taskChangedFiles);
  const foreignFiles = failingUniverse.filter((file) => !attributed.has(file));
  if (foreignFiles.length === 0) return { state, diverted: false };

  const conflict = classifyUserEditConflict({
    files: foreignFiles,
    currentTask: task,
    allTasks: state.tasks,
    currentTaskIndex: taskIndex,
  });
  if (conflict.kind === 'unrelated' || conflict.kind === 'future-task-stale-input') {
    return { state, diverted: false };
  }

  publishUserEditConflict({ bus, phase: state.phase }, conflict, 'pause');
  const issue = buildUserEditConflictRecoveryIssue({
    conflict,
    currentTask: task,
    phase: state.phase,
    createdAt: nowIso(),
  });
  const next = raisePendingRecovery({ projectDir, sessionId, bus }, state, issue, setTrackedState);
  return { state: next, diverted: true };
}

import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { changedFilesSinceBaseline, type ChangedFilesBaseline } from '../changed-files-baseline.js';
import {
  classifyUserEditConflict,
  normalizeUserEditConflictAction,
} from './conflicts.js';
import { publishRecoveryPrompted, publishUserEditConflict, publishWarning, publishWarningFromError } from '../events.js';
import { nowIso } from '../../../utils/format-time.js';
import { transitionAndSave } from '../state-ops.js';
import { buildUserEditConflictRecoveryIssue } from '../recovery/builders/workflow.js';

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
  const { projectDir, sessionId, callbacks, bus, task, taskIndex, baseline, acknowledgedUserEditFiles, setTrackedState } = opts;
  let { state } = opts;
  try {
    const changedFiles = await changedFilesSinceBaseline(projectDir, baseline);
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

    const selectedAction = conflict.safeToContinue
      ? normalizeUserEditConflictAction(
          conflict,
          callbacks.onUserEditConflict
            ? await callbacks.onUserEditConflict(conflict)
            : 'continue-unrelated',
          'continue-unrelated',
        )
      : 'pause';
    publishUserEditConflict({ bus: bus, phase: state.phase }, conflict, selectedAction);

    if (selectedAction === 'continue-unrelated' && conflict.safeToContinue) {
      for (const fileConflict of conflict.fileConflicts) {
        if (fileConflict.kind === 'unrelated' || fileConflict.kind === 'future-task-stale-input') {
          acknowledgedUserEditFiles.add(fileConflict.file);
        }
      }
      return { state, stopped: false };
    }

    if (selectedAction === 'regenerate-rebase') {
      publishWarning({ bus: bus, phase: state.phase },
        'User edit conflict needs regenerate/rebase; workflow paused so the plan or task can be revised against the current files.',
      );
    }

    const issue = buildUserEditConflictRecoveryIssue({
      conflict,
      currentTask: task,
      phase: state.phase,
      createdAt: nowIso(),
    });
    state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PENDING_RECOVERY', issue });
    publishRecoveryPrompted(bus, issue);
    setTrackedState(state);
    return { state, stopped: true };
  } catch (err) {
    publishWarningFromError({ bus: bus, phase: state.phase }, 'Failed to check user edit conflicts', err);
  }
  const issue = buildUserEditConflictRecoveryIssue({
    conflict: {
      kind: 'current-task-conflict',
      files: [],
      affectedTaskIds: [task.id],
      currentTaskId: task.id,
      fileConflicts: [],
      safeToContinue: false,
      availableActions: ['regenerate-rebase', 'pause', 'skip-current-task', 'abort-workflow'],
    },
    currentTask: task,
    phase: state.phase,
    createdAt: nowIso(),
  });
  state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted(bus, issue);
  setTrackedState(state);
  return { state, stopped: true };
}

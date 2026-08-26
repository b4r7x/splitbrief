import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { confinedExists, confinedReadFileAsync } from '../../../lib/confined-fs.js';
import { assertPathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { matches } from '../../../utils/error.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { transitionAndSave } from '../state-ops.js';

const isPathEscape = matches('path-confined-escape');

async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
  assertPathConfined(task.file, projectDir);
  try {
    if (!confinedExists(projectDir, task.file)) {
      const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
      return taskWithoutCurrentCode;
    }
    const currentCode = await confinedReadFileAsync(projectDir, task.file);
    if (currentCode === null) {
      const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
      return taskWithoutCurrentCode;
    }
    return { ...task, currentCode };
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err) || isPathEscape(err)) {
      const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
      return taskWithoutCurrentCode;
    }
    throw err;
  }
}

export async function refreshAndPersistCode(
  task: Task,
  ref: SessionRef,
  state: WorkflowState,
): Promise<{ task: Task; state: WorkflowState }> {
  const refreshed = await refreshCurrentCode(task, ref.projectDir);
  if (refreshed.currentCode !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'UPDATE_TASK_CODE',
      taskId: refreshed.id,
      code: refreshed.currentCode,
    });
  } else if (task.currentCode !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'CLEAR_TASK_CODE',
      taskId: refreshed.id,
    });
  }
  return { task: refreshed, state };
}

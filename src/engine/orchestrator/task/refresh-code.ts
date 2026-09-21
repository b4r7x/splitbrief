import { taskFiles, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { confinedExists, confinedReadFileAsync } from '../../../lib/confined-fs.js';
import { assertPathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { matches } from '../../../utils/error.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { transitionAndSave } from '../state-ops.js';

const isPathEscape = matches('path-confined-escape');

async function readConfined(projectDir: string, file: string): Promise<string | undefined> {
  assertPathConfined(file, projectDir);
  try {
    if (!confinedExists(projectDir, file)) return undefined;
    return (await confinedReadFileAsync(projectDir, file)) ?? undefined;
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err) || isPathEscape(err)) return undefined;
    throw err;
  }
}

async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
  const currentCode = await readConfined(projectDir, task.file);

  const codeByFile: Record<string, string> = {};
  for (const file of taskFiles(task)) {
    if (file === task.file) continue;
    const content = await readConfined(projectDir, file);
    if (content !== undefined) codeByFile[file] = content;
  }

  const { currentCode: _staleCode, currentCodeByFile: _staleCodeByFile, ...base } = task;
  return {
    ...base,
    ...(currentCode !== undefined ? { currentCode } : {}),
    ...(Object.keys(codeByFile).length > 0 ? { currentCodeByFile: codeByFile } : {}),
  };
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
      ...(refreshed.currentCodeByFile ? { codeByFile: refreshed.currentCodeByFile } : {}),
    });
  } else if (task.currentCode !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'CLEAR_TASK_CODE',
      taskId: refreshed.id,
    });
  }
  return { task: refreshed, state };
}

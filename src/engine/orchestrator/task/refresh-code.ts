import { taskFiles, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { confinedExists, confinedReadFileAsync } from '../../../lib/confined-fs.js';
import { assertPathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { matches } from '../../../utils/error.js';
import { anchorAction } from '../../spec/plan-tasks.js';
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

/**
 * Context files share this many characters per task: the file that crosses it is cut with a
 * marker, and the files after it are left out (the brief's Scope still names them). A context file
 * the brief also writes is its writable code, never its read-only context.
 */
export const CONTEXT_CODE_BUDGET_CHARS = 40_000;
const TRUNCATED_MARKER = '\n…truncated';

async function readContextCode(task: Task, projectDir: string): Promise<Record<string, string>> {
  const writable = new Set(taskFiles(task));
  const codeByFile: Record<string, string> = {};
  let remaining = CONTEXT_CODE_BUDGET_CHARS;
  for (const file of task.contextFiles ?? []) {
    if (remaining === 0) break;
    if (writable.has(file)) continue;
    const content = await readConfined(projectDir, file);
    if (content === undefined) continue;
    codeByFile[file] =
      content.length > remaining ? content.slice(0, remaining) + TRUNCATED_MARKER : content;
    remaining = Math.max(0, remaining - content.length);
  }
  return codeByFile;
}

/**
 * The brief as it is dispatched: the code of its files as the checkout holds them now, and the
 * action its anchor takes now, since an earlier brief may have created the anchor since the plan.
 */
export async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
  const currentCode = await readConfined(projectDir, task.file);

  const codeByFile: Record<string, string> = {};
  for (const file of taskFiles(task)) {
    if (file === task.file) continue;
    const content = await readConfined(projectDir, file);
    if (content !== undefined) codeByFile[file] = content;
  }
  const contextCodeByFile = await readContextCode(task, projectDir);

  const {
    currentCode: _staleCode,
    currentCodeByFile: _staleCodeByFile,
    contextCodeByFile: _staleContextCode,
    ...base
  } = task;
  return {
    ...base,
    action: anchorAction(task.file, projectDir),
    ...(currentCode !== undefined ? { currentCode } : {}),
    ...(Object.keys(codeByFile).length > 0 ? { currentCodeByFile: codeByFile } : {}),
    ...(Object.keys(contextCodeByFile).length > 0 ? { contextCodeByFile } : {}),
  };
}

function hasCode(task: Task): boolean {
  return (
    task.currentCode !== undefined ||
    task.currentCodeByFile !== undefined ||
    task.contextCodeByFile !== undefined
  );
}

export async function refreshAndPersistCode(
  task: Task,
  ref: SessionRef,
  state: WorkflowState,
): Promise<{ task: Task; state: WorkflowState }> {
  const refreshed = await refreshCurrentCode(task, ref.projectDir);
  if (hasCode(refreshed) || hasCode(task) || refreshed.action !== task.action) {
    state = transitionAndSave(ref, state, {
      type: 'UPDATE_TASK_CODE',
      taskId: refreshed.id,
      action: refreshed.action,
      ...(refreshed.currentCode !== undefined && { code: refreshed.currentCode }),
      ...(refreshed.currentCodeByFile !== undefined && { codeByFile: refreshed.currentCodeByFile }),
      ...(refreshed.contextCodeByFile !== undefined && {
        contextCodeByFile: refreshed.contextCodeByFile,
      }),
    });
  }
  return { task: refreshed, state };
}

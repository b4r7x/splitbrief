import { isInDeclaredSet, taskDeclaredPatterns } from '../../core/scope/declared-set.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import type { Task } from '../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../core/schemas/workflow.js';
import { orderChangedFiles } from '../change-detection.js';
import { getChangedFilesSinceSnapshot } from './approval/file-snapshots/capture.js';

/** Where the run's code lives: its isolation workspace, or the checkout when it has none. */
export function runCodeDir(projectDir: string, workspace: WorkflowState['workspace']): string {
  return workspace?.path ?? projectDir;
}

/**
 * The brief's own declared files that changed since it started, in the brief's file order: the work
 * an earlier, cut attempt of the brief left on disk.
 */
export async function changedDeclaredFiles(
  codeDir: string,
  task: Task,
  taskStartSnapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  try {
    const patterns = taskDeclaredPatterns(task);
    const changed = (await getChangedFilesSinceSnapshot(codeDir, taskStartSnapshot)).filter(
      (file) => isInDeclaredSet(file, patterns),
    );
    return orderChangedFiles(changed, task.suggestedFiles);
  } catch {
    // Best-effort: a snapshot head the operator rewrote must not stop the restart or the stop.
    return [];
  }
}

/**
 * What a stop that cuts `step` leaves kept: the declared files its brief already changed. A step
 * that is no brief, or a brief other than the running one, whose start the state does not hold,
 * kept nothing that can be named.
 */
export async function keptBriefFiles(
  codeDir: string,
  state: WorkflowState,
  step: StepRef,
): Promise<string[]> {
  if (step.kind !== 'brief') return [];
  const task = state.tasks[state.currentTaskIndex];
  const taskStart = state.changedFilesBaseline?.activeTaskSnapshot;
  if (task?.id !== step.taskId || taskStart === undefined) return [];
  return changedDeclaredFiles(codeDir, task, taskStart);
}

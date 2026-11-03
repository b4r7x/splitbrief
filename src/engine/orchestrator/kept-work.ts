import { isInDeclaredSet, taskDeclaredPatterns } from '../../core/scope/declared-set.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import type { Task } from '../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../core/schemas/workflow.js';
import { orderChangedFiles } from '../change-detection.js';
import { getChangedFilesSinceSnapshot } from './approval/file-snapshots/capture.js';
import type { ImplementerOptions } from '../implementers/types.js';

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

/**
 * A restarted attempt is told about the declared files that already moved, so it
 * edits what is there instead of writing the file again from nothing.
 */
export function changedDeclaredFilesNote(changed: readonly string[]): { extra?: string } {
  if (changed.length === 0) return {};
  return {
    extra: `These declared files changed since this brief started (an earlier attempt of this brief left them): ${changed.join(', ')}`,
  };
}

/**
 * What a brief attempt continues on: the cut attempt's partial, the steer, and the declared files
 * already changed. A cut attempt continues on the files it wrote before the cut; `kept` names them,
 * since a call that finds them complete changes nothing of its own. An attempt that was not cut and
 * carries no steer continues nothing.
 */
export async function briefContinuation(opts: {
  codeDir: string;
  task: Task;
  taskStartSnapshot: ChangedFilesSnapshot;
  partial: string | undefined;
  steer?: string | undefined;
}): Promise<ImplementerOptions['continuation']> {
  const { partial, steer } = opts;
  if (partial === undefined && steer === undefined) return undefined;
  const changed = await changedDeclaredFiles(opts.codeDir, opts.task, opts.taskStartSnapshot);
  const kept = partial !== undefined && changed.length > 0 ? changed : undefined;
  return {
    ...(partial !== undefined && { partial }),
    ...(steer !== undefined && { steer }),
    ...changedDeclaredFilesNote(changed),
    ...(kept !== undefined && { kept }),
  };
}

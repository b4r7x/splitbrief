import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import {
  type ChangedFilesBaseline,
  inferTaskOwnChangedFiles,
  refreshChangedFilesBaseline,
} from '../changed-files-baseline.js';

export async function absorbAcceptedFiles(opts: {
  projectDir: string;
  sessionId: string;
  baseline: ChangedFilesBaseline;
  completedTask: Task | undefined;
  refreshedTask: Task;
  taskAcceptedFiles: Set<string>;
}): Promise<ChangedFilesBaseline> {
  const { projectDir, completedTask, refreshedTask, taskAcceptedFiles } = opts;
  if (
    completedTask !== undefined &&
    isTaskCompleted(completedTask.status) &&
    taskAcceptedFiles.size === 0
  ) {
    for (const file of await inferTaskOwnChangedFiles(
      { projectDir, sessionId: opts.sessionId },
      refreshedTask,
      opts.baseline.head,
      projectDir,
    ))
      taskAcceptedFiles.add(file);
  }
  return refreshChangedFilesBaseline({
    projectDir,
    baseline: opts.baseline,
    absorbedFiles: taskAcceptedFiles,
  });
}

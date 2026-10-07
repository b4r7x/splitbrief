import type { SpecFileRef, SpecMetadata } from '../../core/paths-io.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { Task } from '../../core/schemas/task.js';
import type { EventBus } from '../events/types.js';
import { formatTasks } from '../spec/formatter.js';
import { publishArtifactWritten } from './artifact-card.js';

/** Rewrite `tasks.md` from the run's tasks, so every reader of the file sees the current brief list. */
export function writeTasksArtifact(
  ref: SpecFileRef,
  tasks: readonly Task[],
  metadata: SpecMetadata | null | undefined,
): string {
  const tasksMarkdown = formatTasks(tasks);
  writeSpecFile(ref, TASKS_FILE, tasksMarkdown, metadata);
  return tasksMarkdown;
}

/**
 * Persist `plan.md` and `tasks.md`, the projections of `plan.json`, and announce each as one card.
 * Both files are written before either card is published.
 */
export function writeAndPublishPlanArtifacts(opts: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
  metadata: SpecMetadata | null | undefined;
  planMarkdown: string;
  tasks: Task[];
}): void {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  writeSpecFile(ref, PLAN_FILE, opts.planMarkdown, opts.metadata);
  const tasksMarkdown = writeTasksArtifact(ref, opts.tasks, opts.metadata);
  const card = { bus: opts.bus, phase: opts.phase, ...ref };
  publishArtifactWritten({ ...card, filename: PLAN_FILE, text: opts.planMarkdown });
  publishArtifactWritten({
    ...card,
    filename: TASKS_FILE,
    text: tasksMarkdown,
    briefs: opts.tasks,
  });
}

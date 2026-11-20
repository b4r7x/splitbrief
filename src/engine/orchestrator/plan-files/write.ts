import { join } from 'node:path';
import type { SpecFileRef, SpecMetadata } from '../../../core/sessions/spec-files.js';
import { readSpecFile, writeSpecFile } from '../../../core/sessions/spec-files.js';
import { PLAN_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { Task } from '../../../core/schemas/task.js';
import type { EventBus } from '../../events/types.js';
import { formatTasks } from '../../spec/formatter.js';

/** Rewrite `tasks.md` from the run's tasks, so every reader of the file sees the current brief list. */
export function writeTasksArtifact(
  ref: SpecFileRef,
  tasks: readonly Task[],
  metadata: SpecMetadata | null | undefined,
): void {
  writeSpecFile(ref, TASKS_FILE, formatTasks(tasks), metadata);
}

export function writeAndPublishPlanArtifacts(opts: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
  metadata: SpecMetadata | null | undefined;
  planMarkdown: string;
  tasks: Task[];
  summary: string;
  criteria: number;
}): void {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  const changed = readSpecFile(ref, PLAN_FILE) !== null;
  writeSpecFile(ref, PLAN_FILE, opts.planMarkdown, opts.metadata);
  writeTasksArtifact(ref, opts.tasks, opts.metadata);
  opts.bus.publish({
    type: 'plan_compiled',
    ts: Date.now(),
    phase: opts.phase,
    summary: opts.summary,
    briefs: opts.tasks.length,
    criteria: opts.criteria,
    planPath: join(dir, PLAN_FILE),
    tasksPath: join(dir, TASKS_FILE),
    changed,
  });
}

import type { Task } from '../../../core/schemas/task.js';
import { lineageIdOf, insertTasks } from '../../../core/state/task-insert.js';
import { error } from '../../../utils/error.js';
import { taskFromSpec } from '../../spec/plan/tasks.js';
import { publishTaskReplaced, publishTasksInserted } from '../publish/task.js';
import { publishTasksPlanned } from '../publish/task.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { lineageAnchorAction } from '../task/refresh-code.js';
import type {
  ConsultApplyContext,
  RewriteAction,
  ConsultApplyOutcome,
  SplitAction,
} from './types.js';

const consultApplyError = {
  taskMissing: (id: Task['id']) =>
    error('consult-apply-task-missing', `Task ${id} left the run before its answer applied`, {
      id,
    }),
} as const;

/**
 * A rewrite or a split child continues the lineage of `earlier`, the brief it replaces: a file that
 * lineage created stays `create`, though the workspace holds its output.
 */
async function continuedTask(ctx: ConsultApplyContext, task: Task, earlier: Task): Promise<Task> {
  const action = await lineageAnchorAction(
    ctx,
    ctx.state,
    lineageIdOf(earlier),
    task.suggestedFiles[0],
    ctx.workspaceDir,
  );
  return { ...task, action };
}

/** Rewrites the task in place; the new brief continues on the files the failed attempt left. */
export async function applyRewrite(
  ctx: ConsultApplyContext,
  task: Task,
  action: RewriteAction,
): Promise<ConsultApplyOutcome> {
  const state = transitionAndSave(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    ctx.state,
    {
      type: 'REPLACE_TASK',
      taskId: task.id,
      task: await continuedTask(ctx, taskFromSpec(action.task, ctx.workspaceDir), task),
    },
  );
  ctx.onStateChange?.(state);
  const replaced = state.tasks.find((candidate) => candidate.id === task.id);
  if (replaced === undefined) throw consultApplyError.taskMissing(task.id);
  publishTasksPlanned({ bus: ctx.bus, phase: state.phase }, state.tasks);
  publishTaskReplaced({ bus: ctx.bus, phase: state.phase }, replaced.id, replaced.revision ?? 1);
  return { action: 'rewrite-task', task: replaced };
}

export async function applySplit(
  ctx: ConsultApplyContext,
  task: Task,
  action: SplitAction,
): Promise<ConsultApplyOutcome> {
  const inserted = await Promise.all(
    insertTasks(action.tasks, ctx.state.tasks, (spec) => taskFromSpec(spec, ctx.workspaceDir)).map(
      (child) => continuedTask(ctx, child, task),
    ),
  );
  const state = transitionAndSave(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    ctx.state,
    { type: 'INSERT_TASKS', parentId: task.id, tasks: inserted },
  );
  ctx.onStateChange?.(state);
  const tasks = inserted.map((child) => {
    const saved = state.tasks.find((candidate) => candidate.id === child.id);
    if (saved === undefined) throw consultApplyError.taskMissing(child.id);
    return saved;
  });
  publishTasksPlanned({ bus: ctx.bus, phase: state.phase }, state.tasks);
  publishTasksInserted(
    { bus: ctx.bus, phase: state.phase },
    task.id,
    tasks.map((child) => child.id),
  );
  return { action: 'split-task', tasks };
}

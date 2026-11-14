import type { CrewSeatId } from '../../../core/crew/identity.js';
import type {
  RunnerKind,
  TaskContextFit,
  CurrentCodeContextMode,
  TaskCompletionMethod,
} from '../../../core/schemas/enums.js';
import type { CheckResult, Task, TaskId } from '../../../core/schemas/task.js';
import type { BusContext } from './notice.js';

// Announces the current ordered task list at loop entry and after structural changes.
// `task_started` stays the per-task lifecycle signal.
export function publishTasksPlanned(
  ctx: BusContext,
  tasks: readonly Pick<Task, 'id' | 'title' | 'suggestedFiles' | 'action'>[],
): void {
  ctx.bus.publish({
    type: 'tasks_planned',
    ts: Date.now(),
    phase: ctx.phase,
    tasks: tasks.map((task, index) => ({
      id: task.id,
      title: task.title,
      index,
      file: task.suggestedFiles[0],
      action: task.action,
    })),
    total: tasks.length,
  });
}

export function publishTaskStart(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    title: string;
    index: number;
    total: number;
    lineageAttempt: number;
    file: string;
    files?: string[];
    action: 'create' | 'modify';
    tool?: string;
    model?: string;
    axes?: readonly string[];
    backendKind?: RunnerKind;
    implementerProfile?: string;
    contextFit?: TaskContextFit;
    estimatedTokens?: number;
    untruncatedEstimatedTokens?: number;
    contextLength?: number;
    currentCodeTruncated?: boolean;
    currentCodeContextMode?: CurrentCodeContextMode;
    routingReason?: string;
  },
): void {
  ctx.bus.publish({ type: 'task_started', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishTaskSkipped(
  ctx: BusContext,
  opts: { taskId: TaskId; title: string; reason: string },
): void {
  ctx.bus.publish({ type: 'task_skipped', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishTaskComplete(
  ctx: BusContext,
  opts: {
    taskId: TaskId;
    title: string;
    method: TaskCompletionMethod;
    retries: number;
    duration: number;
    tool?: string;
    model?: string;
    implementerProfile?: string;
  },
): void {
  ctx.bus.publish({ type: 'task_completed', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishTaskReplaced(ctx: BusContext, taskId: TaskId, revision: number): void {
  ctx.bus.publish({ type: 'task_replaced', ts: Date.now(), phase: ctx.phase, taskId, revision });
}

export function publishTasksInserted(
  ctx: BusContext,
  parentId: TaskId,
  taskIds: readonly TaskId[],
): void {
  ctx.bus.publish({
    type: 'tasks_inserted',
    ts: Date.now(),
    phase: ctx.phase,
    parentId,
    taskIds: [...taskIds],
  });
}

export function publishTaskValidating(
  ctx: BusContext,
  taskId: TaskId,
  check?: { id: string; command: string; scenario?: string | undefined },
): void {
  ctx.bus.publish({
    type: 'task_validating',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    ...(check !== undefined && {
      check: {
        id: check.id,
        command: check.command,
        ...(check.scenario !== undefined && { scenario: check.scenario }),
      },
    }),
  });
}

export function publishChecksRun(
  ctx: BusContext,
  taskId: TaskId,
  results: readonly CheckResult[],
): void {
  ctx.bus.publish({
    type: 'checks_run',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    results: [...results],
  });
}

export function publishNoProgressCut(
  ctx: BusContext,
  opts: { taskId: TaskId | null; seat: CrewSeatId; silentMs: number },
): void {
  ctx.bus.publish({ type: 'no_progress_cut', ts: Date.now(), phase: ctx.phase, ...opts });
}

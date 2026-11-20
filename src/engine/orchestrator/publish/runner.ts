import type { PlannerCall } from '../../../core/schemas/run-step.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { redactSecrets } from '../../../utils/redact/secrets.js';
import { projectRunnerCallEvents } from '../../calls/event-projection.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import type { EngineEventOf, TextChunkMarks, EventBus, EngineEvent } from '../../events/types.js';
import type { Implementer, ImplementerPublisher } from '../../implementers/types.js';
import { publishWarning } from './notice.js';
import type { BusContext } from './notice.js';
import { admitUsageLimitWarning } from './usage-limit-gate.js';

type PlannerTextOptions = Pick<Partial<EngineEventOf<'planner_text'>>, 'role' | 'content'>;

let runnerCallEventSequence = 0;

export function publishRunnerCallEvent(
  ctx: BusContext & { rootDir: string; taskId?: TaskId | undefined },
  event: RunnerCallEvent,
): void {
  if (!admitUsageLimitWarning(ctx.bus, event)) return;
  const projected = projectRunnerCallEvents(event, {
    phase: ctx.phase,
    rootDir: ctx.rootDir,
    ...(ctx.taskId !== undefined && { taskId: ctx.taskId }),
    sequence: runnerCallEventSequence,
  });
  runnerCallEventSequence += 1;
  for (const projectedEvent of projected) ctx.bus.publish(projectedEvent);
}

export function createBusTextHandler(
  ctx: BusContext,
  options: PlannerTextOptions = {},
): (text: string, marks?: TextChunkMarks) => void {
  const { role, content } = options;
  return (text, marks) =>
    ctx.bus.publish({
      type: 'planner_text',
      ts: Date.now(),
      phase: ctx.phase,
      text,
      ...(role !== undefined && { role }),
      ...(content !== undefined && { content }),
      ...(marks?.messageStart === true && { messageStart: true }),
      ...(marks?.continues === true && { continues: true }),
      ...(marks?.subagentId !== undefined && { subagentId: marks.subagentId }),
    });
}

export function createImplementerTextHandler(ctx: BusContext, implementer: Implementer) {
  const writesDirectly = implementer.capabilities?.writesFiles === 'direct';
  const handler = createBusTextHandler(ctx, {
    role: 'implementer',
    content: writesDirectly ? 'markdown' : 'plain',
  });
  return (text: string, marks?: TextChunkMarks) =>
    handler(text, { ...marks, messageStart: writesDirectly && marks?.messageStart === true });
}

export function publishPlannerStatus(
  bus: EventBus,
  state: WorkflowState,
  status: 'running' | 'done',
  extra?: {
    duration?: number;
    summary?: string;
    tool?: string;
    model?: string;
    call?: PlannerCall;
  },
): void {
  const tool = extra?.tool ?? state.plannerTool;
  // A named tool brings its own model, or none: the planner's never stands in for another seat's.
  const model = extra?.tool === undefined ? (extra?.model ?? state.plannerModel) : extra.model;
  bus.publish({
    type: 'planner_status',
    ts: Date.now(),
    phase: state.phase,
    status,
    ...(extra?.duration !== undefined && { duration: extra.duration }),
    ...(extra?.summary !== undefined && { summary: extra.summary }),
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
    ...(extra?.call !== undefined && { call: extra.call }),
  });
}

export function publishImplementerGenerateRunning(
  ctx: BusContext,
  opts: Omit<Parameters<ImplementerPublisher['publishRunning']>[0], 'phase'>,
): void {
  ctx.bus.publish({
    type: 'implementer_generate_running',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    ...(opts.file !== undefined && { file: opts.file }),
    ...(opts.lineageAttempt !== undefined && { lineageAttempt: opts.lineageAttempt }),
  });
}

export function publishImplementerGenerateDone(
  ctx: BusContext,
  opts: Omit<Parameters<ImplementerPublisher['publishDone']>[0], 'phase'>,
): void {
  const event: EngineEvent = {
    type: 'implementer_generate_done',
    ts: Date.now(),
    phase: ctx.phase,
    taskId: opts.taskId,
    file: opts.file,
    files: opts.files,
    ...(opts.linesAdded !== undefined && { linesAdded: opts.linesAdded }),
    ...(opts.linesRemoved !== undefined && { linesRemoved: opts.linesRemoved }),
    duration: opts.duration,
    ...(opts.noChange === true && { noChange: true }),
    ...(opts.kept !== undefined && opts.kept.length > 0 && { kept: [...opts.kept] }),
  };
  if (opts.diff !== undefined) event.diff = redactSecrets(opts.diff);
  ctx.bus.publish(event);
}

function publishImplementerGenerateFailed(
  ctx: BusContext,
  taskId: TaskId,
  model?: string,
  error?: string,
): void {
  ctx.bus.publish({
    type: 'implementer_generate_failed',
    ts: Date.now(),
    phase: ctx.phase,
    taskId,
    ...(model !== undefined && { model }),
    ...(error !== undefined && { error: redactSecrets(error) }),
  });
}

export function createImplementerPublisher(bus: EventBus): ImplementerPublisher {
  return {
    publishRunning: ({ phase, ...opts }) => publishImplementerGenerateRunning({ bus, phase }, opts),
    publishCallEvent: ({ phase, taskId, rootDir, event }) =>
      publishRunnerCallEvent({ bus, phase, taskId, rootDir }, event),
    publishDone: ({ phase, ...opts }) => publishImplementerGenerateDone({ bus, phase }, opts),
    publishFailed: ({ phase, taskId, model, error }) =>
      publishImplementerGenerateFailed({ bus, phase }, taskId, model, error),
    publishWarning: ({ phase, taskId, message, safety }) =>
      publishWarning({ bus, phase, taskId, message, safety }),
  };
}

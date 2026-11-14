import type { SeatIdentity } from '../../../core/providers/seat-identity.js';
import type { AttachedInput } from '../../../core/schemas/attachment.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { AnsweredQuestion, ClarificationQuestion } from '../../../core/schemas/question.js';
import type { TaskId } from '../../../core/schemas/task.js';
import { labelError } from '../../../utils/format/errors.js';
import type { EventBus } from '../../events/types.js';

export type BusContext = {
  bus: EventBus;
  phase: Phase;
};

interface OperationalMessageSafety {
  readonly category: string;
  readonly code: string;
}

interface PublishOperationalMessageOptions extends BusContext {
  message: string;
  taskId?: TaskId | undefined;
  safety?: OperationalMessageSafety | undefined;
  /** An error's usage-limit reset, as the halt's `resetAt` names it; the row spells it when read. */
  resetAt?: string | undefined;
  /** The files a put-back of the running brief still acts on, on a revert, restore or denial row. */
  briefKept?: number | undefined;
}

export function publishError(options: PublishOperationalMessageOptions): void {
  const { bus, phase, message, safety, resetAt, briefKept } = options;
  bus.publish({
    type: 'error',
    ts: Date.now(),
    phase,
    message,
    ...(safety !== undefined && {
      category: safety.category,
      code: safety.code,
    }),
    ...(resetAt !== undefined && { resetAt }),
    ...(briefKept !== undefined && { briefKept }),
  });
}

export function publishDebug(
  options: BusContext & { message: string; safety?: OperationalMessageSafety | undefined },
): void {
  const { bus, phase, message, safety } = options;
  bus.publish({
    type: 'debug',
    ts: Date.now(),
    phase,
    message,
    ...(safety !== undefined && {
      category: safety.category,
      code: safety.code,
    }),
  });
}

export function publishInfo(
  options: BusContext & { message: string; briefKept?: number | undefined },
): void {
  const { bus, phase, message, briefKept } = options;
  bus.publish({
    type: 'info',
    ts: Date.now(),
    phase,
    message,
    ...(briefKept !== undefined && { briefKept }),
  });
}

export function publishWarning(options: PublishOperationalMessageOptions): void {
  const { bus, phase, message, taskId, safety, briefKept } = options;
  bus.publish({
    type: 'warning',
    ts: Date.now(),
    phase,
    message,
    ...(taskId !== undefined && { taskId }),
    ...(safety !== undefined && {
      category: safety.category,
      code: safety.code,
    }),
    ...(briefKept !== undefined && { briefKept }),
  });
}

export function publishWarningFromError(ctx: BusContext, label: string, err: unknown): void {
  publishWarning({ ...ctx, message: labelError(label, err) });
}

export function publishUserMessage(
  ctx: BusContext,
  text: string,
  options: {
    qa?: AnsweredQuestion[];
    questions?: readonly ClarificationQuestion[];
    attachedInputs?: readonly AttachedInput[] | undefined;
  } = {},
): void {
  const { qa, questions, attachedInputs } = options;
  ctx.bus.publish({
    type: 'user_message',
    ts: Date.now(),
    phase: ctx.phase,
    text,
    ...(qa !== undefined && qa.length > 0 ? { qa } : {}),
    ...(questions !== undefined ? { questions: [...questions] } : {}),
    ...(attachedInputs !== undefined && attachedInputs.length > 0
      ? { attachedInputs: [...attachedInputs] }
      : {}),
  });
}

/** The seats this run pass holds, complete, so the chrome names them until their change point. */
export function publishWorkflowConfig(
  ctx: BusContext,
  opts: SeatIdentity & { skills?: string[] | undefined },
): void {
  ctx.bus.publish({
    type: 'workflow_config',
    ts: Date.now(),
    phase: ctx.phase,
    plannerTool: opts.plannerTool,
    ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
    ...(opts.plannerKind !== undefined && { plannerKind: opts.plannerKind }),
    ...(opts.plannerAxes !== undefined && { plannerAxes: [...opts.plannerAxes] }),
    implementerTool: opts.implementerTool,
    ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
    ...(opts.implementerKind !== undefined && { implementerKind: opts.implementerKind }),
    ...(opts.implementerAxes !== undefined && { implementerAxes: [...opts.implementerAxes] }),
    ...(opts.reviewerTool !== undefined && { reviewerTool: opts.reviewerTool }),
    ...(opts.reviewerModel !== undefined && { reviewerModel: opts.reviewerModel }),
    ...(opts.reviewerKind !== undefined && { reviewerKind: opts.reviewerKind }),
    ...(opts.reviewerAxes !== undefined && { reviewerAxes: [...opts.reviewerAxes] }),
    ...(opts.reviewerSeat !== undefined && { reviewerSeat: opts.reviewerSeat }),
    ...(opts.skills !== undefined && { skills: opts.skills }),
  });
}

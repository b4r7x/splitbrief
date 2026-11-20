import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import type { EventBus } from '../../events/types.js';
import type { BundleApplyResult } from '../../implementers/file-bundle/contract.js';
import { persistApiApplyEvidence } from '../evidence/api-apply.js';
import type { WorkflowContext, WorkflowPersistenceContext } from '../types.js';
import { recordBriefCorrection } from '../state-ops/corrections.js';
import { commitQueueMessagesDrained, readQueueForPrompt } from './drain.js';
import { formatDrainedMessages, formatMessageInput, imagesFromMessages } from './prompt.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { settleMidCallDeliveries } from './mid-call.js';
import { seatSupportsImages } from '../../../core/runners/capabilities.js';
import { resolveSeatImageFact } from '../../providers/model/resolution.js';

type BuildImageContext = Pick<WorkflowContext, 'config' | 'modelCache'>;

export function buildSeatSupportsImages(wctx: BuildImageContext): boolean {
  const runner = wctx.config.implementer;
  return seatSupportsImages({
    runner,
    detected: resolveSeatImageFact({ runner, role: 'implementer', cache: wctx.modelCache }),
  });
}

export function publishBuildImagesAsPaths(
  opts: BuildImageContext &
    Pick<WorkflowContext, 'bus'> & {
      state: WorkflowState;
      taskId: TaskId;
      count: number;
    },
): void {
  if (opts.count === 0 || buildSeatSupportsImages(opts)) return;
  opts.bus.publish({
    type: 'build_images_as_paths',
    ts: Date.now(),
    phase: opts.state.phase,
    taskId: opts.taskId,
    count: opts.count,
  });
}

type BuildCorrectionOptions = BuildImageContext & {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  taskId: TaskId;
  bus: EventBus;
};

/** The words sent into a cut brief attempt are a correction of that brief, read by its next call. */
export function recordSteerCorrection(
  opts: BuildCorrectionOptions & { message: UserMessageInput },
): WorkflowState {
  const text = formatMessageInput(opts.message);
  if (!text.trim()) return opts.state;
  const state = recordBriefCorrection(opts, opts.state, opts.taskId, text, opts.message.images);
  publishBuildImagesAsPaths({ ...opts, state, count: opts.message.images.length });
  return state;
}

export function buildCorrectionInput(
  state: WorkflowState,
  task: Task,
  wctx: BuildImageContext,
): Pick<ImplementerOptions, 'images' | 'continuation'> {
  const lineage = state.lineages?.[lineageIdOf(task)];
  const corrections = lineage?.corrections ?? [];
  const images = lineage?.correctionImages;
  return {
    ...(images !== undefined && buildSeatSupportsImages(wctx) && { images }),
    ...(corrections.length > 0 && { continuation: { steer: corrections.join('\n\n') } }),
  };
}

export function absorbBuildCorrections(opts: BuildCorrectionOptions): {
  state: WorkflowState;
  count: number;
} {
  return absorbBuildCorrectionsById(opts);
}

export function absorbBuildCorrectionsById(
  opts: BuildCorrectionOptions & {
    ids?: readonly string[];
    via?: 'mid-call' | undefined;
  },
): { state: WorkflowState; count: number } {
  const read = readQueueForPrompt(opts);
  const drained = commitQueueMessagesDrained({
    ...opts,
    state: read.state,
    messages: read.messages,
    seat: 'build',
    taskId: opts.taskId,
  });
  if (drained.count === 0) return drained;

  const delivered = read.messages.filter((message) =>
    drained.state.messageQueue.some(
      (current) => current.id === message.id && current.deliveredTo?.implementer !== undefined,
    ),
  );
  const text = formatDrainedMessages(delivered).trim();
  const images = imagesFromMessages(delivered);
  const state = recordBriefCorrection(opts, drained.state, opts.taskId, text, images);
  publishBuildImagesAsPaths({ ...opts, state, count: images.length });
  return {
    state,
    count: drained.count,
  };
}

export async function runWithCorrectionPasses<
  T extends {
    success: boolean;
    applyResult?: BundleApplyResult | undefined;
  },
>(opts: {
  ref: SessionRef;
  first: () => Promise<T>;
  pass: () => Promise<T>;
  absorb: () => number;
  signal?: AbortSignal | undefined;
  application: {
    wctx: WorkflowPersistenceContext;
    state: () => WorkflowState;
    task: Task;
    workspacePath: string;
  };
}): Promise<T> {
  const execute = async (call: () => Promise<T>): Promise<T> => {
    const result = await call();
    if (result.applyResult !== undefined) {
      persistApiApplyEvidence({
        ...opts.application,
        state: opts.application.state(),
        result: result.applyResult,
      });
    }
    return result;
  };
  let result = await execute(opts.first);
  while (result.success && !opts.signal?.aborted) {
    await settleMidCallDeliveries(opts.ref);
    if (opts.signal?.aborted || opts.absorb() === 0) break;
    result = await execute(opts.pass);
  }
  return result;
}

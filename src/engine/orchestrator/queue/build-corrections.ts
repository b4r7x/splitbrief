import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import type { EventBus } from '../../events/types.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { persistApiApplyEvidence } from '../evidence/persistence.js';
import type { WorkflowPersistenceContext } from '../types.js';
import { recordBriefCorrection } from '../state-ops.js';
import { commitQueueMessagesDrained, readQueueForPrompt } from './drain.js';
import { formatDrainedMessages, imagesFromMessages } from './prompt.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { settleMidCallDeliveries } from './mid-call.js';

type BuildCorrectionOptions = {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  taskId: TaskId;
  bus: EventBus;
};

export function buildCorrectionInput(
  state: WorkflowState,
  task: Task,
): Pick<ImplementerOptions, 'images' | 'continuation'> {
  const lineage = state.lineages?.[lineageIdOf(task)];
  const corrections = lineage?.corrections ?? [];
  const images = lineage?.correctionImages;
  return {
    ...(images !== undefined && { images }),
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
  return {
    state: recordBriefCorrection(
      opts,
      drained.state,
      opts.taskId,
      text,
      imagesFromMessages(delivered),
    ),
    count: drained.count,
  };
}

export async function runWithCorrectionPasses<
  T extends {
    success: boolean;
    usage?: TokenDelta | null | undefined;
    applyResult?: BundleApplyResult | undefined;
  },
>(opts: {
  ref: SessionRef;
  first: () => Promise<T>;
  pass: () => Promise<T>;
  absorb: () => number;
  signal?: AbortSignal | undefined;
  onDiscardedUsage: (usage: TokenDelta) => void;
  application: {
    wctx: WorkflowPersistenceContext;
    state: () => WorkflowState;
    task: Task;
    workspacePath: string;
  };
}): Promise<T> {
  let usage: TokenDelta | null | undefined;
  let completedUsage: TokenDelta | null | undefined;
  let completedBeforeAbort = false;
  const execute = async (call: () => Promise<T>): Promise<T> => {
    const result = await call();
    if (result.usage != null) usage = accumulateTokenUsage(usage ?? null, result.usage);
    completedBeforeAbort = !opts.signal?.aborted;
    if (completedBeforeAbort) completedUsage = usage;
    if (result.applyResult !== undefined) {
      persistApiApplyEvidence({
        ...opts.application,
        state: opts.application.state(),
        result: result.applyResult,
      });
    }
    return result;
  };
  const discardUsage = (): boolean => {
    if (completedUsage == null) return false;
    const discarded = completedUsage;
    completedUsage = undefined;
    opts.onDiscardedUsage(discarded);
    return true;
  };
  try {
    let result = await execute(opts.first);
    while (result.success && !opts.signal?.aborted) {
      await settleMidCallDeliveries(opts.ref);
      if (opts.signal?.aborted || opts.absorb() === 0) break;
      result = await execute(opts.pass);
    }
    // A completed call is booked on discard; only an interrupted call still belongs to its caller.
    if (opts.signal?.aborted && discardUsage()) {
      return completedBeforeAbort ? { ...result, usage: undefined } : result;
    }
    return { ...result, ...(usage != null && { usage }) };
  } catch (err) {
    discardUsage();
    throw err;
  }
}

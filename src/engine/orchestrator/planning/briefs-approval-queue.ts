import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { readQueueForPrompt, releaseQueueMessagesForPrompt } from '../queue/drain.js';
import { runBriefQuality } from './brief-quality-run.js';
import type { BriefsApprovalLoopResult } from './types.js';

type QueuedBriefPreparationOptions = {
  tasks: Task[];
  state: WorkflowState;
  planner: Planner;
  wctx: PlannerCallbacksContext;
  qualityValidatedTasks?: Task[] | undefined;
};

export type QueuedBriefPreparationResult =
  | { kind: 'none'; state: WorkflowState; tasks: Task[] }
  | { kind: 'prepared'; state: WorkflowState; tasks: Task[] }
  | { kind: 'failed'; result: BriefsApprovalLoopResult };

export async function prepareQueuedBriefs(
  opts: QueuedBriefPreparationOptions,
): Promise<QueuedBriefPreparationResult> {
  const queued = readQueueForPrompt({
    projectDir: opts.wctx.projectDir,
    sessionId: opts.wctx.sessionId,
    state: opts.state,
  });
  if (queued.messages.length === 0 && opts.qualityValidatedTasks !== undefined) {
    return { kind: 'none', state: queued.state, tasks: opts.tasks };
  }

  try {
    const quality = await runBriefQuality({
      tasks: opts.tasks,
      state: queued.state,
      planner: opts.planner,
      wctx: opts.wctx,
      ...(queued.messages.length > 0 ? { queuedMessages: queued.messages } : {}),
    });
    if (!quality.ok) {
      return {
        kind: 'failed',
        result: {
          state: quality.result.state,
          tasks: quality.result.tasks,
          rejected: false,
          failed: quality.result.failed,
          ...(quality.result.cancelled && !quality.result.failed && { aborted: true }),
        },
      };
    }

    return { kind: 'prepared', state: quality.state, tasks: quality.tasks };
  } finally {
    releaseQueueMessagesForPrompt(
      { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      queued.messages,
    );
  }
}

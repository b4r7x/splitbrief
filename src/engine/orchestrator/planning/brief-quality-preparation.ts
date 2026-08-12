import type { Task } from '../../../core/schemas/task.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { EventBus } from '../../events/types.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { Planner } from '../../planners/types.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import {
  briefErrorMessages,
  firstBriefError,
  firstBriefErrorMessage,
} from '../../spec/brief-quality.js';
import { createBusTextHandler } from '../events.js';
import { planningError } from './errors.js';
import { buildBriefQualityRepairComment } from './regen-targeted.js';
import { regenerateTasks } from './regen.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import {
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';

type BriefQualityPreparationOptions = {
  tasks: Task[];
  state: WorkflowState;
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  metadata: SpecMetadata;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
  queuedMessages?: readonly QueuedMessage[] | undefined;
};

type BriefQualityPreparationResult =
  | {
      ok: true;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
    }
  | {
      ok: false;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
      error: ReturnType<typeof planningError.briefQualityGateFailed>;
    };

export async function prepareBriefQuality(
  opts: BriefQualityPreparationOptions,
): Promise<BriefQualityPreparationResult> {
  let state = opts.state;
  let tasks = opts.tasks;
  const pendingQueue =
    opts.queuedMessages === undefined
      ? readQueueForPrompt({
          projectDir: opts.projectDir,
          sessionId: opts.sessionId,
          state,
        })
      : { state, messages: [...opts.queuedMessages] };
  state = pendingQueue.state;
  let queuedMessages: readonly QueuedMessage[] = pendingQueue.messages;

  if (queuedMessages.length > 0) {
    const summary = 'applying queued input before the brief quality gate';
    createBusTextHandler({ bus: opts.bus, phase: state.phase })(`
[${summary}]
`);
    let regenerated: Awaited<ReturnType<typeof regenerateTasks>>;
    try {
      regenerated = await regenerateTasks({
        projectDir: opts.projectDir,
        sessionId: opts.sessionId,
        planner: opts.planner,
        callbacks: opts.callbacks,
        bus: opts.bus,
        state,
        metadata: opts.metadata,
        signal: opts.signal,
        queuedMessages,
        commitQueue: false,
        statusPhase: 'planning',
        statusSummary: summary,
        sinks: opts.sinks,
      });
    } catch (err) {
      releasePromptMessages(opts, queuedMessages);
      throw err;
    }
    state = regenerated.state;
    tasks = regenerated.tasks;
    queuedMessages = regenerated.queuedMessages;
  }

  const first = runBriefQualityGate({
    tasks,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    bus: opts.bus,
    phase: state.phase,
  });
  if (first.ok) {
    return {
      ok: true,
      state:
        queuedMessages.length === 0
          ? state
          : commitQueueMessagesDrained({
              projectDir: opts.projectDir,
              sessionId: opts.sessionId,
              state,
              messages: queuedMessages,
              bus: opts.bus,
            }).state,
      tasks,
      report: first.report,
    };
  }

  const summary = 'regenerating Task Briefs to clear the brief quality gate';
  createBusTextHandler({ bus: opts.bus, phase: opts.state.phase })(`\n[${summary}]\n`);

  let regenerated: Awaited<ReturnType<typeof regenerateTasks>>;
  try {
    regenerated = await regenerateTasks({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      planner: opts.planner,
      callbacks: opts.callbacks,
      bus: opts.bus,
      state,
      metadata: opts.metadata,
      signal: opts.signal,
      feedback: buildBriefQualityRepairComment(briefErrorMessages(first.report)),
      queuedMessages,
      commitQueue: false,
      statusPhase: 'planning',
      statusSummary: summary,
      sinks: opts.sinks,
    });
  } catch (err) {
    releasePromptMessages(opts, queuedMessages);
    throw err;
  }

  state = regenerated.state;
  tasks = regenerated.tasks;
  const second = runBriefQualityGate({
    tasks,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    bus: opts.bus,
    phase: state.phase,
  });
  if (second.ok) {
    return {
      ok: true,
      state:
        regenerated.queuedMessages.length === 0
          ? state
          : commitQueueMessagesDrained({
              projectDir: opts.projectDir,
              sessionId: opts.sessionId,
              state,
              messages: regenerated.queuedMessages,
              bus: opts.bus,
            }).state,
      tasks,
      report: second.report,
    };
  }

  createBusTextHandler({ bus: opts.bus, phase: state.phase })(
    `\n[Brief quality gate still failing after regeneration: ${firstBriefErrorMessage(second.report)}]\n`,
  );
  releasePromptMessages(opts, regenerated.queuedMessages);

  const firstError = firstBriefError(second.report);
  return {
    ok: false,
    state,
    tasks,
    report: second.report,
    error: planningError.briefQualityGateFailed(
      firstError?.code ?? 'unknown',
      String(firstError?.taskId ?? 'unknown'),
    ),
  };
}

function releasePromptMessages(
  opts: BriefQualityPreparationOptions,
  messages: ReadonlyArray<{ id: string }>,
): void {
  releaseQueueMessagesForPrompt(
    { projectDir: opts.projectDir, sessionId: opts.sessionId },
    messages,
  );
}

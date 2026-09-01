import type { BriefQualityReport } from '../../spec/brief-quality.js';
import type { Task } from '../../../core/schemas/task.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { EventBus } from '../../events/types.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { Planner } from '../../planners/types.js';
import { createBusTextHandler } from '../events.js';
import type { planningError } from './errors.js';
import { regenerateTasks } from './regen.js';
import { readQueueForPrompt, releaseQueueMessagesForPrompt } from '../queue/drain.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryController,
  QueueResultV1,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';

type RecoveryControllerClient = Pick<
  BriefRecoveryController,
  | 'inspectBriefRecovery'
  | 'enterBriefAdmission'
  | 'queueBriefInput'
  | 'dispatchBriefAction'
  | 'settlePlannerAttempt'
>;

export type BriefQualityAdmissionContext = {
  tasks: Task[];
  state: WorkflowState;
  projectDir: string;
  sessionId: string;
};

export type BriefQualityRecoveryBinding = {
  controller: RecoveryControllerClient;
  authority: StateAuthorityReceipt;
  createAdmissionInput: (input: BriefQualityAdmissionContext) => BriefAdmissionInput;
  /** The workflow owner exposes the persisted state for terminal recovery decisions. */
  readState?: () => WorkflowState;
};

export type BriefQualityControllerResult = RecoveryResultV1 | QueueResultV1;

export type BriefQualityPreparationOptions = {
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
  recovery?: BriefQualityRecoveryBinding | undefined;
};

export type BriefQualityPreparationError =
  | ReturnType<typeof planningError.briefQualityGateFailed>
  | {
      kind: 'brief-recovery-blocked';
      data: { code: string; taskId: string };
    };

export type BriefQualityPreparationResult =
  | {
      ok: true;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
      projection: BriefRecoveryProjectionV1;
      recovery: BriefQualityControllerResult | null;
    }
  | {
      ok: false;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
      projection: BriefRecoveryProjectionV1;
      recovery: BriefQualityControllerResult | null;
      error: BriefQualityPreparationError;
    };

const fallbackAllowedActions = [
  'status',
] satisfies readonly BriefRecoveryProjectionV1['allowedActions'][number][];

export function fallbackBriefRecoveryProjection(
  sessionId: string,
  state: WorkflowState,
): BriefRecoveryProjectionV1 {
  return {
    version: 1,
    sessionId,
    stateRevision: state.stateRevision ?? 0,
    recoveryRevision: 0,
    epochId: null,
    status: 'storage-blocked',
    origin: null,
    continuation: null,
    activeBrief: null,
    matchingReport: null,
    blocker: {
      kind: 'storage',
      code: 'brief_storage_invalid',
      message: 'Brief recovery controller is unavailable.',
    },
    allowedActions: fallbackAllowedActions,
    activeOperation: null,
    latestAttempt: null,
    queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
  };
}

export function releasePromptMessages(
  opts: BriefQualityPreparationOptions,
  messages: ReadonlyArray<{ id: string }>,
): void {
  releaseQueueMessagesForPrompt(
    { projectDir: opts.projectDir, sessionId: opts.sessionId },
    messages,
  );
}

export type QueuedTasksPreparation = {
  state: WorkflowState;
  tasks: Task[];
  messages: readonly QueuedMessage[];
};

export async function prepareQueuedTasks(
  opts: BriefQualityPreparationOptions,
): Promise<QueuedTasksPreparation> {
  const pending =
    opts.queuedMessages === undefined
      ? readQueueForPrompt({
          projectDir: opts.projectDir,
          sessionId: opts.sessionId,
          state: opts.state,
        })
      : { state: opts.state, messages: [...opts.queuedMessages] };
  if (pending.messages.length === 0) {
    return { state: pending.state, tasks: opts.tasks, messages: [] };
  }

  const summary = 'applying queued input before the brief quality gate';
  createBusTextHandler({ bus: opts.bus, phase: pending.state.phase })(`\n[${summary}]\n`);
  try {
    const regenerated = await regenerateTasks({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      planner: opts.planner,
      callbacks: opts.callbacks,
      bus: opts.bus,
      state: pending.state,
      metadata: opts.metadata,
      signal: opts.signal,
      queuedMessages: pending.messages,
      commitQueue: false,
      statusPhase: 'planning',
      statusSummary: summary,
      sinks: opts.sinks,
    });
    return {
      state: regenerated.state,
      tasks: regenerated.tasks,
      messages: regenerated.queuedMessages,
    };
  } catch (err) {
    releasePromptMessages(opts, pending.messages);
    throw err;
  }
}

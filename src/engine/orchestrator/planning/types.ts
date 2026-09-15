import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { PlannerCallbacksContext } from '../types.js';
import type {
  PhaseCallResult,
  PhaseInputs,
  Planner,
  PlannerDocumentCall,
} from '../../planners/types.js';
import type { GateName, PlannerCall } from '../../../core/schemas/run-step.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { ApproveLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';

export type PlanningPhaseOptions = {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  feature: string;
  selectedSkills?: SkillMeta[] | undefined;
  rewindPending?: { target: 'spec' | 'plan'; comment?: string | undefined } | undefined;
  rewindFeedback?: string | undefined;
  codebaseContext?: string | undefined;
  approveLevel?: ApproveLevel | undefined;
  attachments?: Attachment[] | undefined;
  /** The advisor classified this prompt as a trivial edit, so the quick planner prompt drops its codebase-review step and caps the brief count. */
  trivial?: boolean | undefined;
  /**
   * Gate the run's first real planner call (the `pre_planning` hook). Returning
   * false cancels the turn. Called once per process, by whichever path issues
   * that call.
   */
  beforeFirstCall?: (() => Promise<boolean>) | undefined;
};

export type PlanningStepsOptions = PlanningPhaseOptions & {
  /** Step to start the scan at; defaults to the step `resumeStep` names. */
  startAt?: PlannerCall | undefined;
  /** Gates already answered in this turn, so an approved gate never re-opens. */
  passedGates?: readonly GateName[] | undefined;
};

/**
 * How a planning phase stopped. `closed` is the user ending the run at a gate,
 * `interrupted` an abort that parked the step, `halted` a recovery the operator
 * has to answer; only `failed` is an error nothing can resume from in place.
 */
export type PlanningTerminalOutcome = 'cancelled' | 'closed' | 'failed' | 'interrupted' | 'halted';

export type PlanningPhaseResult =
  | Readonly<{ disposition: 'ready-for-tasks'; state: WorkflowState; tasks: readonly Task[] }>
  | Readonly<{
      disposition: 'terminal';
      state: WorkflowState;
      outcome: PlanningTerminalOutcome;
    }>;

export type PlanningProducerResult =
  | Readonly<{ disposition: 'tasks-ready'; state: WorkflowState; tasks: readonly Task[] }>
  | Readonly<{
      disposition: 'terminal';
      state: WorkflowState;
      outcome: PlanningTerminalOutcome;
    }>;

export type PlannerCallRunResult = {
  state: WorkflowState;
  result: PhaseCallResult;
};

export type PlannerCallOptions = {
  wctx: PlannerCallbacksContext;
  state: WorkflowState;
  planner: Planner;
  call: PlannerDocumentCall;
  inputs: PhaseInputs;
  collectedQuestions?: ClarificationQuestion[] | undefined;
  phaseHint?: string | undefined;
};

export type BriefsApprovalLoopOptions = {
  tasks: Task[];
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: import('../types.js').OrchestratorCallbacks;
  bus: import('../../events/types.js').EventBus;
  state: WorkflowState;
  config: Config;
  metadata: SpecMetadata;
  signal?: AbortSignal | undefined;
  sinks?: import('../types.js').WorkflowSinks | undefined;
  modelCache?: ModelCacheAccessor | undefined;
  detectedContextLength?: number | undefined;
};

export type BriefsApprovalLoopResult = {
  state: WorkflowState;
  tasks: Task[];
  outcome: 'accepted' | 'aborted' | 'failed' | 'closed' | 'halted';
};

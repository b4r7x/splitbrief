import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { Planner, PlanResult, PriorMessage } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { ApproveLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { PhaseRecoveryBinding } from '../run/phases.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type { BriefGenerationRef, TaskExecutionPermit } from '../../../core/schemas/brief-owner.js';

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
  afterSpecReview?: (input: {
    state: WorkflowState;
    tasks: Task[];
  }) => Promise<{ state: WorkflowState; tasks: Task[]; cancelled?: boolean | undefined }>;
  /**
   * The workflow owner supplies recovery for the full planning lifecycle.
   * Direct producer callers may intentionally omit it; producers then stop at
   * their persisted handoff instead of constructing a synthetic owner.
   */
  recovery?: PhaseRecoveryBinding;
};

export type PlanningRunContext = {
  approveLevel: ApproveLevel;
  metadata: SpecMetadata;
  skillsContext: string | undefined;
  state: WorkflowState;
};

export type PlanningPhaseResult =
  | Readonly<{
      disposition: 'ready-for-tasks';
      state: WorkflowState;
      generation: BriefGenerationRef;
      tasks: readonly Task[];
      permit: TaskExecutionPermit;
    }>
  | Readonly<{
      disposition: 'parked';
      state: WorkflowState;
      projection: BriefRecoveryProjectionV1;
    }>
  | Readonly<{
      disposition: 'terminal';
      state: WorkflowState;
      outcome: 'cancelled' | 'rejected' | 'failed';
    }>;

export type PlannerCallRunResult = {
  state: WorkflowState;
  result: PlanResult;
};

export type PlannerCallOptions = {
  wctx: PlannerCallbacksContext;
  state: WorkflowState;
  planner: Planner;
  feature: string;
  skillsContext?: string | undefined;
  codebaseContext?: string | undefined;
  priorMessages?: PriorMessage[] | undefined;
  collectedQuestions?: ClarificationQuestion[] | undefined;
  attachments?: Attachment[] | undefined;
  /** The advisor classified this prompt as a trivial edit, so the quick planner prompt drops its codebase-review step and caps the brief count. */
  trivial?: boolean | undefined;
  phaseHint?: string | undefined;
};

export type BriefsApprovalLoopOptions = {
  tasks: Task[];
  qualityValidatedTasks?: Task[] | undefined;
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: import('../types.js').OrchestratorCallbacks;
  bus: import('../../events/types.js').EventBus;
  state: WorkflowState;
  config: Config;
  metadata: import('../../../core/paths-io.js').SpecMetadata;
  signal?: AbortSignal | undefined;
  sinks?: import('../types.js').WorkflowSinks | undefined;
  modelCache?: ModelCacheAccessor | undefined;
  detectedContextLength?: number | undefined;
};

export type BriefsApprovalLoopResult = {
  state: WorkflowState;
  tasks: Task[];
  rejected: boolean;
  outcome: 'accepted' | 'aborted' | 'failed' | 'rejected';
  aborted?: boolean | undefined;
};

import type { Config } from '../../core/schemas/config.js';
import type { BriefReviewPromptKind, Phase } from '../../core/schemas/enums.js';
import type { StepCut } from '../../core/schemas/run-step.js';
import type { ContinuationHolder } from './continuation.js';
import type { ProjectContext } from '../../core/state/types.js';
import type { Planner, PriorMessage } from '../planners/types.js';
import type { Reviewer } from '../reviewers/types.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import type { SpecMetadata } from '../../core/paths-io.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { Validator } from './validation/types.js';
import type { RunIsolation } from './isolation/types.js';
import type { EventBus } from '../events/types.js';
import type { SteeringPort } from '../calls/steering.js';
import type {
  ApprovalReviewResult,
  ReviewChecksApprovalAnswer,
  ReviewChecksApprovalRequest,
  TieredApprovalRequest,
  TieredApprovalResponse,
} from '../../core/approval/types.js';
import type { ApprovalReviewInput } from '../runners/types.js';
import type { ModelCacheAccessor } from '../providers/model/resolution.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StreamingSink } from './task/streaming-feed.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { RoutingDecision } from './context-routing/types.js';
import type { PlannerConversation } from '../../core/schemas/workflow.js';
import type { PlannerReplyAnswer } from '../../core/schemas/question.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
export interface OrchestratorCallbacks {
  onPlannerReply?:
    | ((reply: PlannerConversation) => Promise<UserMessageInput | PlannerReplyAnswer | undefined>)
    | undefined;
  /** `confirms`: the protected operations approving confirms in advance, as the gate names them. */
  onApprovalNeeded: (
    type: BriefReviewPromptKind,
    input: ApprovalReviewInput,
    confirms: readonly string[],
  ) => Promise<ApprovalReviewResult>;
  /**
   * Parks the run until the operator continues it, resolving with their steer.
   * `at` says what they are looking at: a call cut in flight, or a run held
   * between two briefs. `kept` names the declared files a cut brief had already
   * changed; it is empty for a boundary, a step that is no brief, or a brief that
   * changed nothing yet.
   */
  onContinuationNeeded?:
    | ((partialResponse: string, at: StepCut, kept: readonly string[]) => Promise<UserMessageInput>)
    | undefined;
  onTieredApproval?:
    | ((request: TieredApprovalRequest) => Promise<TieredApprovalResponse>)
    | undefined;
  /**
   * Shows the reviewer checks before they run when `validation.approve_checks` is `ask`. Only a
   * screen wires it: a run without it (headless) runs none of the commands. Undefined is a prompt
   * closed without an answer.
   */
  onReviewChecksApproval?:
    | ((request: ReviewChecksApprovalRequest) => Promise<ReviewChecksApprovalAnswer | undefined>)
    | undefined;
  onComplete: (summary: Summary) => void;
}

export interface ResumeContextHolder {
  messages: PriorMessage[];
}

export type QueueSubmissionResult =
  | { status: 'accepted'; messageId: string; preview?: string | undefined }
  | { status: 'rejected'; reason: 'queue-full' | 'phase-unavailable'; message: string };

export type QueueClearResult =
  | { status: 'cleared'; count: number }
  | { status: 'unavailable'; message: string };

export type QueueHandler = (
  message: UserMessageInput,
  phase: Phase,
) => QueueSubmissionResult | Promise<QueueSubmissionResult>;
export type ClearQueueHandler = () => QueueClearResult | Promise<QueueClearResult>;

/** Why the engine stopped at a brief boundary: the operator's pause, or a seat change. */
export type BoundaryPark = 'pause' | 'seat-change';

export interface WorkflowSinks {
  setAbortHandler: (handler: (() => void) | null) => void;
  setQueueHandler: (handler: QueueHandler | null) => void;
  setClearQueueHandler?: ((handler: ClearQueueHandler | null) => void) | undefined;
  consumeBoundaryInterrupt?: () => boolean;
  /**
   * What holds the run at this boundary, or `undefined` to carry on: `'pause'` for a pause the
   * operator asked for, `'seat-change'` for one that only changes a seat. Reading it clears the
   * pending pause.
   */
  consumeBoundaryPause?: () => BoundaryPark | undefined;
  /** When the operator resumed the held continuation, before the engine saved its next state. */
  getContinuationResumedAt?: () => number | null | undefined;
}

export interface WorkflowContext {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  planner: Planner;
  steering?: SteeringPort | undefined;
  reviewer: Reviewer;
  context: ProjectContext;
  implementer: Implementer;
  createImplementer?:
    | ((options?: ImplementerFactoryOptions) => Implementer | Promise<Implementer>)
    | undefined;
  implementerProfile?: string | undefined;
  routingDecision?: RoutingDecision | undefined;
  signal?: AbortSignal | undefined;
  metadata: SpecMetadata;
  resumeHolder?: ResumeContextHolder | undefined;
  sinks: WorkflowSinks;
  isolation: RunIsolation;
  validator: Validator;
  modelCache?: ModelCacheAccessor | undefined;
  drainPendingAttachments?: (() => Attachment[]) | undefined;
  streamingSink?: StreamingSink | undefined;
  plannerContext?: string | undefined;
  detectedContextLength?: number | undefined;
  /**
   * The continuation this run carries: the partial its cut attempt left and the
   * steer that restarted it. The step the run stopped at takes it; every other
   * step sees nothing.
   */
  continuation?: ContinuationHolder | undefined;
}

export type WorkflowPersistenceContext = SessionRef & { bus: EventBus };

export type PlannerCallbacksContext = Pick<
  WorkflowContext,
  | 'projectDir'
  | 'sessionId'
  | 'config'
  | 'callbacks'
  | 'bus'
  | 'signal'
  | 'metadata'
  | 'resumeHolder'
  | 'sinks'
  | 'drainPendingAttachments'
  | 'modelCache'
  | 'plannerContext'
  | 'detectedContextLength'
  | 'continuation'
  | 'steering'
> & {
  /** The run's skills block, as `context.skillsContext` carries it. */
  skillsContext?: string | undefined;
};

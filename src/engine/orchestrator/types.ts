import type { Config } from '../../core/schemas/config.js';
import type { BriefReviewPromptKind } from '../../core/schemas/brief-review-command.js';
import type { Phase, UserEditConflictAction } from '../../core/schemas/enums.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { ProjectContext } from '../../core/state/types.js';
import type { Planner, PriorMessage } from '../planners/types.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import type { SpecMetadata } from '../../core/paths-io.js';
import type { CostPrediction, Summary } from '../../core/schemas/summary.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { Validator } from './validation/types.js';
import type { EventBus } from '../events/types.js';
import type {
  ApprovalReviewResult,
  TieredApprovalRequest,
  TieredApprovalResponse,
} from '../../core/approval/types.js';
import type {
  UserEditConflict,
  TaskReviewRequest,
  TaskReviewResponse,
} from '../events/workflow-events.js';
import type { RoutingDecision } from './context-routing/types.js';
import type { ModelCacheAccessor } from '../providers/model/resolution.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StreamingSink } from './task/streaming-feed.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { ApprovalReviewInput } from '../runners/types.js';
import {
  WORKFLOW_CANCEL_REASONS,
  WORKFLOW_CANCEL_REASON_USER,
  WORKFLOW_USER_CANCELLED_ABORT_REASON,
  isWorkflowCancelledAbortReason,
  workflowCancelledReasonFromSignal,
} from '../events/workflow-cancel.js';
import type {
  WorkflowCancelledAbortReason,
  WorkflowCancelReason,
} from '../events/workflow-cancel.js';

export {
  WORKFLOW_CANCEL_REASONS,
  WORKFLOW_CANCEL_REASON_USER,
  WORKFLOW_USER_CANCELLED_ABORT_REASON,
  isWorkflowCancelledAbortReason,
  workflowCancelledReasonFromSignal,
};

export type { WorkflowCancelledAbortReason, WorkflowCancelReason };

export interface OrchestratorCallbacks {
  onApprovalNeeded: (
    type: BriefReviewPromptKind,
    input: ApprovalReviewInput,
  ) => Promise<ApprovalReviewResult>;
  onUserEditConflict?:
    | ((conflict: UserEditConflict) => Promise<UserEditConflictAction>)
    | undefined;
  onQuestionAsked?:
    | ((question: ClarificationQuestion, num: number, total: number) => Promise<string>)
    | undefined;
  onCostApprovalNeeded?: ((prediction: CostPrediction) => Promise<boolean>) | undefined;
  onContinuationNeeded?: ((partialResponse: string) => Promise<string>) | undefined;
  onTieredApproval?:
    | ((request: TieredApprovalRequest) => Promise<TieredApprovalResponse>)
    | undefined;
  onTaskReviewNeeded?: ((request: TaskReviewRequest) => Promise<TaskReviewResponse>) | undefined;
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
  text: string,
  phase: Phase,
) => QueueSubmissionResult | Promise<QueueSubmissionResult>;
export type ClearQueueHandler = () => QueueClearResult | Promise<QueueClearResult>;

export interface WorkflowSinks {
  setAbortHandler: (handler: (() => void) | null) => void;
  setQueueHandler: (handler: QueueHandler | null) => void;
  setClearQueueHandler?: ((handler: ClearQueueHandler | null) => void) | undefined;
  consumeBoundaryInterrupt?: () => boolean;
}

export interface WorkflowContext {
  projectDir: string;
  sessionId: string;
  config: Config;
  getApprovalEnabled?: (() => boolean) | undefined;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  planner: Planner;
  context: ProjectContext;
  implementer: Implementer;
  createImplementer?:
    | ((config: Config, options?: ImplementerFactoryOptions) => Implementer | Promise<Implementer>)
    | undefined;
  allowRepoRunners?: boolean | undefined;
  implementerProfile?: string | undefined;
  retryProfileOverride?: string | undefined;
  retryProfileOverrideTaskId?: TaskId | undefined;
  routingDecision?: RoutingDecision | undefined;
  signal?: AbortSignal | undefined;
  metadata: SpecMetadata;
  resumeHolder?: ResumeContextHolder | undefined;
  sinks: WorkflowSinks;
  validator: Validator;
  modelCache?: ModelCacheAccessor | undefined;
  drainPendingAttachments?: (() => Attachment[]) | undefined;
  streamingSink?: StreamingSink | undefined;
  plannerContext?: string | undefined;
  detectedContextLength?: number | undefined;
  setRewindFeedback?: ((feedback: string | undefined) => void) | undefined;
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
>;

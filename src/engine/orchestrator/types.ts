import type { Config } from '../../core/schemas/config.js';
import type { Phase, UserEditConflictAction } from '../../core/schemas/enums.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { ProjectContext } from '../../core/state/types.js';
import type { Planner, PriorMessage } from '../planners/types.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import type { SpecMetadata } from '../../core/paths-io.js';
import type { CostPrediction, Summary } from '../../core/schemas/summary.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { Validator } from './validation.js';
import type { EventBus } from '../events/types.js';
import type { TieredApprovalRequest, TieredApprovalResponse } from '../../core/approval/types.js';
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

export const WORKFLOW_CANCEL_REASONS = ['user_cancelled'] as const;
export const WORKFLOW_CANCEL_REASON_USER = WORKFLOW_CANCEL_REASONS[0];

export type WorkflowCancelReason = (typeof WORKFLOW_CANCEL_REASONS)[number];

export type WorkflowCancelledAbortReason = {
  type: 'workflow_cancelled';
  reason: WorkflowCancelReason;
};

export const WORKFLOW_USER_CANCELLED_ABORT_REASON = Object.freeze({
  type: 'workflow_cancelled',
  reason: WORKFLOW_CANCEL_REASON_USER,
} satisfies WorkflowCancelledAbortReason);

export function isWorkflowCancelledAbortReason(
  value: unknown,
): value is WorkflowCancelledAbortReason {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || !('reason' in value)) return false;
  return value.type === 'workflow_cancelled' && value.reason === WORKFLOW_CANCEL_REASON_USER;
}

export function workflowCancelledReasonFromSignal(
  signal: AbortSignal | undefined,
): WorkflowCancelReason | undefined {
  if (!signal?.aborted) return undefined;
  return isWorkflowCancelledAbortReason(signal.reason) ? signal.reason.reason : undefined;
}

export interface OrchestratorCallbacks {
  onApprovalNeeded: (
    type: 'spec' | 'plan' | 'briefs',
    filePath: string,
  ) => Promise<{ approved: boolean; comment?: string | undefined; action?: 'edit' | undefined }>;
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

export type QueueHandler = (text: string, phase: Phase) => void;
export type ClearQueueHandler = () => number;

export interface WorkflowSinks {
  setAbortHandler: (handler: (() => void) | null) => void;
  setQueueHandler: (handler: QueueHandler | null) => void;
  setClearQueueHandler?: ((handler: ClearQueueHandler | null) => void) | undefined;
}

export interface WorkflowContext {
  projectDir: string;
  sessionId: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  planner: Planner;
  context: ProjectContext;
  implementer: Implementer;
  createImplementer?:
    | ((config: Config, options?: ImplementerFactoryOptions) => Implementer | Promise<Implementer>)
    | undefined;
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

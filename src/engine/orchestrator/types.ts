import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
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
import type { UserEditConflict, UserEditConflictAction } from './user-edit/conflicts.js';
import type { RoutingDecision } from './context-routing/types.js';
import type { TaskReviewRequest, TaskReviewResponse } from './task/review.js';
import type { ModelCacheAccessor } from '../providers/model/resolution.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StreamingSink } from './task/streaming-feed.js';

export interface OrchestratorCallbacks {
  onApprovalNeeded: (type: 'spec' | 'plan' | 'briefs', filePath: string) => Promise<{ approved: boolean; comment?: string | undefined; action?: 'edit' | undefined }>;
  onUserEditConflict?: ((conflict: UserEditConflict) => Promise<UserEditConflictAction>) | undefined;
  onQuestionAsked?: ((question: ClarificationQuestion, num: number, total: number) => Promise<string>) | undefined;
  onBudgetExceeded?: ((currentCost: number, maxBudget: number) => Promise<boolean>) | undefined;
  onBudgetPaused?: ((currentCost: number, maxBudget: number) => Promise<'continue' | 'abort' | 'raise'>) | undefined;
  onCostApprovalNeeded?: ((prediction: CostPrediction) => Promise<boolean>) | undefined;
  onContinuationNeeded?: ((partialResponse: string) => Promise<string>) | undefined;
  onTieredApproval?: ((request: TieredApprovalRequest) => Promise<TieredApprovalResponse>) | undefined;
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
  createImplementer?: ((config: Config, options?: ImplementerFactoryOptions) => Implementer | Promise<Implementer>) | undefined;
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
}

export type PlannerCallbacksContext = Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'config' | 'callbacks' | 'bus' | 'signal' | 'metadata' | 'resumeHolder' | 'sinks' | 'drainPendingAttachments'>;

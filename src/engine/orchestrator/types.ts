import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { ProjectContext } from '../../core/types/state-actions.js';
import type { Planner, PriorMessage } from '../planners/types.js';
import type { Implementer } from '../implementers/types.js';
import type { SpecMetadata } from '../../core/paths-io.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { Validator } from './validation.js';
import type { EventBus } from '../events/types.js';
import type { TieredApprovalRequest, TieredApprovalResponse } from './tiered-approval.js';
import type { UserEditConflict, UserEditConflictAction } from './user-edit-conflicts.js';
import type { RoutingDecision } from './context-routing.js';

export interface OrchestratorCallbacks {
  onApprovalNeeded: (type: 'spec' | 'plan' | 'briefs', filePath: string) => Promise<{ approved: boolean; comment?: string | undefined; action?: 'edit' | undefined }>;
  /** @deprecated User-edit gating is now file-aware through onUserEditConflict. */
  onExternalChanges?: (() => Promise<boolean>) | undefined;
  onUserEditConflict?: ((conflict: UserEditConflict) => Promise<UserEditConflictAction>) | undefined;
  onQuestionAsked?: ((question: ClarificationQuestion, num: number, total: number) => Promise<string>) | undefined;
  onBudgetExceeded?: ((currentCost: number, maxBudget: number) => Promise<boolean>) | undefined;
  onBudgetPaused?: ((currentCost: number, maxBudget: number) => Promise<'continue' | 'abort' | 'raise'>) | undefined;
  onContinuationNeeded?: ((partialResponse: string) => Promise<string>) | undefined;
  onTieredApproval?: ((request: TieredApprovalRequest) => Promise<TieredApprovalResponse>) | undefined;
  onComplete: (summary: Summary) => void;
}

export interface ResumeContextHolder {
  messages: PriorMessage[];
}

export type QueueHandler = (text: string, phase: Phase) => void;

export interface WorkflowSinks {
  setAbortHandler: (handler: (() => void) | null) => void;
  setQueueHandler: (handler: QueueHandler | null) => void;
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
  createImplementer?: ((config: Config) => Implementer) | undefined;
  implementerProfile?: string | undefined;
  routingDecision?: RoutingDecision | undefined;
  signal?: AbortSignal | undefined;
  metadata: SpecMetadata;
  resumeHolder?: ResumeContextHolder | undefined;
  sinks: WorkflowSinks;
  validator: Validator;
}

export type PlannerCallbacksContext = Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'config' | 'callbacks' | 'bus' | 'signal' | 'metadata' | 'resumeHolder' | 'sinks'>;

import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { ProjectContext } from '../../core/types/state-actions.js';
import type { Planner, PriorMessage } from '../planners/types.js';
import type { Implementer } from '../implementers/types.js';
import type { SpecMetadata } from '../../core/paths-io.js';
import type { TuiEvent } from '../../features/workflow/types.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { Validator } from './validation.js';

export interface OrchestratorCallbacks {
  onEvent: (event: TuiEvent) => void;
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string | undefined }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: ((question: ClarificationQuestion, num: number, total: number) => Promise<string>) | undefined;
  onBudgetExceeded?: ((currentCost: number, maxBudget: number) => Promise<boolean>) | undefined;
  onContinuationNeeded?: ((partialResponse: string) => Promise<string>) | undefined;
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
  planner: Planner;
  context: ProjectContext;
  implementer: Implementer;
  signal?: AbortSignal | undefined;
  metadata: SpecMetadata;
  resumeHolder?: ResumeContextHolder | undefined;
  sinks: WorkflowSinks;
  validator: Validator;
}

export type PlannerCallbacksContext = Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'config' | 'callbacks' | 'signal' | 'metadata' | 'resumeHolder' | 'sinks'>;

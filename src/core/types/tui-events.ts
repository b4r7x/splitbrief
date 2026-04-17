import type { Phase, TaskId } from './state-actions.js';
import type { Summary, TaskCompletionMethod, TokenUsage, CostPrediction } from './summary.js';
import type { WorkflowMode } from './config-options.js';
import type { ClarificationQuestion } from './schemas/question.js';
export type { ClarificationQuestion } from './schemas/question.js';

export type ValidationStages = { tsc: boolean; lint: boolean; test: boolean };

export type TuiEvent =
  | {
      type: 'planner-status';
      ts: number;
      phase: Phase;
      status: 'running' | 'done';
      summary?: string | undefined;
      duration?: number | undefined;
      tool?: string | undefined;
      model?: string | undefined;
    }
  | {
      type: 'planner-text';
      ts: number;
      text: string;
    }
  | {
      type: 'task-start';
      ts: number;
      taskId: TaskId;
      title: string;
      index: number;
      total: number;
      file: string;
      action: 'create' | 'modify';
      tool?: string | undefined;
      model?: string | undefined;
    }
  | {
      type: 'task-complete';
      ts: number;
      taskId: TaskId;
      title: string;
      method: TaskCompletionMethod;
      retries: number;
      duration: number;
      tool?: string | undefined;
      model?: string | undefined;
    }
  | {
      type: 'task-skipped';
      ts: number;
      taskId: TaskId;
      title: string;
      reason: string;
    }
  | {
      type: 'implementer-generate-running';
      ts: number;
      file?: string | undefined;
    }
  | {
      type: 'implementer-generate-done';
      ts: number;
      file: string;
      diff?: string | undefined;
      linesAdded: number;
      linesRemoved: number;
      duration: number;
    }
  | {
      type: 'implementer-generate-failed';
      ts: number;
      model: string;
    }
  | {
      type: 'validate';
      ts: number;
      status: 'running' | 'done';
      passed: boolean;
      stages: ValidationStages;
      error?: string | undefined;
      duration?: number | undefined;
    }
  | {
      type: 'retry';
      ts: number;
      taskId: TaskId;
      attempt: number;
      maxRetries: number;
    }
  | {
      type: 'escalate';
      ts: number;
      tier: 0 | 1 | 2;
      hint?: string | undefined;
      tool?: string | undefined;
      model?: string | undefined;
    }
  | {
      type: 'git-commit';
      ts: number;
      message: string;
    }
  | {
      type: 'git-checkpoint';
      ts: number;
      tag: string;
      taskId: TaskId;
    }
  | {
      type: 'warning';
      ts: number;
      message: string;
    }
  | {
      type: 'error';
      ts: number;
      message: string;
    }
  | {
      type: 'cost-update';
      ts: number;
      tokenUsage: TokenUsage;
    }
  | {
      type: 'cost-prediction';
      ts: number;
      prediction: CostPrediction;
    }
  | {
      type: 'budget-warning';
      ts: number;
      currentCost: number;
      maxBudget: number;
    }
  | {
      type: 'budget-exceeded';
      ts: number;
      currentCost: number;
      maxBudget: number;
    }
  | {
      type: 'workflow-cancelled';
      ts: number;
    }
  | {
      type: 'workflow-config';
      ts: number;
      mode: WorkflowMode;
      plannerTool: string;
      plannerModel?: string | undefined;
      implementerTool: string;
      implementerModel?: string | undefined;
    }
  | {
      type: 'rewind';
      ts: number;
      target: 'spec' | 'plan';
      comment?: string | undefined;
    }
  | {
      type: 'task-reset';
      ts: number;
      taskId: TaskId;
    }
  | {
      type: 'message-queued';
      ts: number;
      id: string;
      phase: Phase;
    }
  | {
      type: 'message-injected-native';
      ts: number;
      id: string;
    }
  | {
      type: 'queue-drained';
      ts: number;
      count: number;
    }
  | {
      type: 'queue-cleared';
      ts: number;
      count: number;
    }
  | {
      type: 'user-message';
      ts: number;
      text: string;
    };

export interface OrchestratorCallbacks {
  onEvent: (event: TuiEvent) => void;
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string | undefined }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: ((question: ClarificationQuestion, num: number, total: number) => Promise<string>) | undefined;
  onBudgetExceeded?: ((currentCost: number, maxBudget: number) => Promise<boolean>) | undefined;
  onContinuationNeeded?: ((partialResponse: string) => Promise<string>) | undefined;
  onComplete: (summary: Summary) => void;
}

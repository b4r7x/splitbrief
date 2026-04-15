import type { Phase, TaskId } from './workflow.js';
import type { Summary, TaskCompletionMethod, TokenUsage, CostPrediction } from './summary.js';
import type { WorkflowMode } from './config.js';
export type { ClarificationQuestion } from './schemas/question.js';
import type { ClarificationQuestion } from './schemas/question.js';

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
    };

export type OrchestratorEventPayloadMap = {
  workflow_started: Record<string, never>;
  workflow_resumed: Record<string, never>;
  workflow_complete: Record<string, never>;
  all_tasks_done: Record<string, never>;
  task_started: Record<string, never>;
  task_completed: { method: TaskCompletionMethod };
  task_failed: Record<string, never>;
  task_skipped: Record<string, never>;
  task_retry: { attempt: number; error: string };
  task_escalating: Record<string, never>;
  task_full_fail: Record<string, never>;
  task_tokens: {
    method: TaskCompletionMethod;
    implementerTokens: number;
    escalationTokens: number;
    retryCount: number;
  };
  hint_failed: Record<string, never>;
  paused_external_changes: Record<string, never>;
  spec_rejected: Record<string, never>;
  spec_regenerated: { comment: string };
  plan_rejected: Record<string, never>;
  plan_regenerated: { comment: string };
  clarifications_collected: {
    count: number;
    clarifications: Array<{ question: string; answer: string }>;
  };
  research_done: Record<string, never>;
  spec_done: Record<string, never>;
  spec_approved: Record<string, never>;
  plan_done: { taskCount: number };
  plan_approved: Record<string, never>;
  rewind_to_spec: { comment?: string };
  rewind_to_plan: { comment?: string };
  task_reset: { taskId: string };
  message_queued: { id: string; phase: Phase };
  message_injected_native: { id: string };
  queue_drained: { count: number };
  queue_cleared: { count: number };
};

export type OrchestratorEventType = keyof OrchestratorEventPayloadMap;

export type OrchestratorEvent<T extends OrchestratorEventType = OrchestratorEventType> = {
  [K in T]: {
    ts: number;
    type: K;
    taskId?: TaskId | undefined;
    phase: Phase;
    data: OrchestratorEventPayloadMap[K];
  };
}[T];

export type SessionLogEventEntry = {
  ts: string;
  kind: 'event';
  type: OrchestratorEventType;
  taskId?: TaskId | undefined;
  phase: Phase;
  data: OrchestratorEventPayloadMap[OrchestratorEventType];
};

export type SessionLogMessageEntry = {
  ts: string;
  kind: 'message';
  role: 'user' | 'assistant';
  phase?: Phase | undefined;
  text: string;
  interrupted?: boolean | undefined;
  queuedAt?: string | undefined;
  drainedAt?: string | undefined;
};

export type SessionLogEntry = SessionLogEventEntry | SessionLogMessageEntry;

export interface OrchestratorCallbacks {
  onEvent: (event: TuiEvent) => void;
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string | undefined }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: ((question: ClarificationQuestion, num: number, total: number) => Promise<string>) | undefined;
  onBudgetExceeded?: ((currentCost: number, maxBudget: number) => Promise<boolean>) | undefined;
  onContinuationNeeded?: ((partialResponse: string) => Promise<string>) | undefined;
  onComplete: (summary: Summary) => void;
}

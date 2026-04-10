import type { Phase, TaskId } from './workflow.js';
import type { Summary, TaskCompletionMethod, TokenUsage } from './summary.js';

export type ClarificationQuestion =
  | { id: string; type: 'choice'; text: string; options: string[]; default?: string | undefined }
  | { id: string; type: 'input'; text: string; default?: string | undefined }
  | { id: string; type: 'confirm'; text: string; default?: boolean | undefined };

export type TuiEvent =
  | {
      type: 'planner-status';
      ts: number;
      phase: Phase;
      status: 'running' | 'done';
      summary?: string | undefined;
      duration?: number | undefined;
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
    }
  | {
      type: 'task-complete';
      ts: number;
      taskId: TaskId;
      title: string;
      method: TaskCompletionMethod;
      retries: number;
      duration: number;
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
      stages: { tsc: boolean; lint: boolean; test: boolean };
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
      tier: 1 | 2;
      hint?: string | undefined;
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
      type: 'workflow-cancelled';
      ts: number;
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

export interface OrchestratorCallbacks {
  onEvent: (event: TuiEvent) => void;
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string | undefined }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: ((question: ClarificationQuestion, num: number, total: number) => Promise<string>) | undefined;
  onComplete: (summary: Summary) => void;
}

import type { Phase } from './workflow.js';
import type { Summary } from './summary.js';
import type { TaskCompletionMethod, TokenUsage } from './summary.js';

export interface ClarificationQuestion {
  id: string;
  type: 'choice' | 'input' | 'confirm';
  text: string;
  options?: string[] | undefined;
  default?: string | number | boolean | undefined;
}

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
      taskId: string;
      title: string;
      index: number;
      total: number;
      file: string;
      action: 'create' | 'modify';
    }
  | {
      type: 'task-complete';
      ts: number;
      taskId: string;
      title: string;
      method: TaskCompletionMethod;
      retries: number;
      duration: number;
    }
  | {
      type: 'task-skipped';
      ts: number;
      taskId: string;
      title: string;
      reason: string;
    }
  | {
      type: 'implementer-generate';
      ts: number;
      status: 'running';
      file?: string | undefined;
    }
  | {
      type: 'implementer-generate';
      ts: number;
      status: 'done';
      file: string;
      diff?: string | undefined;
      linesAdded: number;
      linesRemoved: number;
      duration: number;
    }
  | {
      type: 'implementer-generate';
      ts: number;
      status: 'failed';
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
      taskId: string;
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
      taskId: string;
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

export interface OrchestratorEvent {
  ts: number;
  type: OrchestratorEventType;
  taskId?: string | undefined;
  phase: Phase;
  data?: Record<string, unknown> | undefined;
}

export type OrchestratorEventType =
  | 'workflow_started'
  | 'workflow_resumed'
  | 'workflow_complete'
  | 'all_tasks_done'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_skipped'
  | 'task_retry'
  | 'task_escalating'
  | 'task_full_fail'
  | 'task_tokens'
  | 'hint_failed'
  | 'paused_external_changes'
  | 'spec'
  | 'spec_rejected'
  | 'spec_regenerated'
  | 'plan'
  | 'plan_rejected'
  | 'plan_regenerated'
  | 'clarifications_collected'
  | 'research_done'
  | 'spec_done'
  | 'spec_approved'
  | 'plan_done'
  | 'plan_approved';

export interface OrchestratorCallbacks {
  onEvent: (event: TuiEvent) => void;
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string | undefined }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: ((question: ClarificationQuestion, num: number, total: number) => Promise<string>) | undefined;
  onComplete: (summary: Summary) => void;
}

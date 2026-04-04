import type { ClarificationQuestion } from '../../engine/question-parser.js';
import type { Phase } from './workflow.js';
import type { Summary } from './summary.js';
import type { TaskCompletionMethod } from './tokens.js';

export type TuiEvent =
  | {
      type: 'planner-status';
      ts: number;
      phase: Phase;
      status: 'running' | 'done';
      summary?: string;
      duration?: number;
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
      status: 'running' | 'done' | 'failed';
      model?: string;
      file?: string;
      linesAdded?: number;
      linesRemoved?: number;
      diff?: string;
      duration?: number;
    }
  | {
      type: 'validate';
      ts: number;
      status: 'running' | 'done';
      passed: boolean;
      stages: { tsc: boolean; lint: boolean; test: boolean };
      error?: string;
      duration?: number;
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
      hint?: string;
    }
  | {
      type: 'git-commit';
      ts: number;
      message: string;
    }
  | {
      type: 'error';
      ts: number;
      message: string;
    };

export interface OrchestratorEvent {
  ts: number;
  type: OrchestratorEventType;
  taskId?: string;
  phase: Phase;
  data?: Record<string, unknown>;
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
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: (question: ClarificationQuestion, num: number, total: number) => Promise<string>;
  onComplete: (summary: Summary) => void;
}

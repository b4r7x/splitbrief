import type { TaskId } from '../../core/schemas/task.js';
import type { Phase, TaskCompletionMethod, WorkflowMode } from '../../core/schemas/enums.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';

export type ValidationStages = { tsc: boolean; lint: boolean; test: boolean };

export type EngineEvent =
  // Workflow lifecycle
  | { type: 'workflow_started'; ts: number; phase: Phase; feature: string }
  | { type: 'workflow_resumed'; ts: number; phase: Phase }
  | { type: 'workflow_complete'; ts: number; phase: Phase }
  | { type: 'workflow_cancelled'; ts: number; phase: Phase }
  | { type: 'workflow_config'; ts: number; phase: Phase; mode: WorkflowMode; plannerTool: string; plannerModel?: string; implementerTool: string; implementerModel?: string }
  | { type: 'paused_external_changes'; ts: number; phase: Phase }
  // Planner stream
  | { type: 'planner_status'; ts: number; phase: Phase; status: 'running' | 'done'; tool?: string; model?: string; duration?: number; summary?: string }
  | { type: 'planner_text'; ts: number; phase: Phase; text: string }
  // Planning phase milestones
  | { type: 'research_done'; ts: number; phase: Phase }
  | { type: 'spec_done'; ts: number; phase: Phase }
  | { type: 'spec_approved'; ts: number; phase: Phase }
  | { type: 'spec_rejected'; ts: number; phase: Phase }
  | { type: 'spec_regenerated'; ts: number; phase: Phase; comment: string }
  | { type: 'plan_done'; ts: number; phase: Phase; taskCount: number }
  | { type: 'plan_approved'; ts: number; phase: Phase }
  | { type: 'plan_rejected'; ts: number; phase: Phase }
  | { type: 'plan_regenerated'; ts: number; phase: Phase; comment: string }
  | { type: 'rewind_to_spec'; ts: number; phase: Phase; comment?: string }
  | { type: 'rewind_to_plan'; ts: number; phase: Phase; comment?: string }
  | { type: 'all_tasks_done'; ts: number; phase: Phase }
  // Task lifecycle
  | { type: 'task_started'; ts: number; phase: Phase; taskId: TaskId; title: string; index: number; total: number; file: string; action: 'create' | 'modify'; tool?: string; model?: string }
  | { type: 'task_completed'; ts: number; phase: Phase; taskId: TaskId; title: string; method: TaskCompletionMethod; retries: number; duration: number; tool?: string; model?: string }
  | { type: 'task_failed'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'task_skipped'; ts: number; phase: Phase; taskId: TaskId; title: string; reason: string }
  | { type: 'task_retry'; ts: number; phase: Phase; taskId: TaskId; attempt: number; maxRetries: number; error: string }
  | { type: 'task_escalating'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'task_full_fail'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'task_reset'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'task_tokens'; ts: number; phase: Phase; taskId: TaskId; method: TaskCompletionMethod; implementerTokens: number; escalationTokens: number; retryCount: number }
  | { type: 'hint_failed'; ts: number; phase: Phase; taskId: TaskId }
  // Implementer
  | { type: 'implementer_generate_running'; ts: number; phase: Phase; taskId: TaskId; file?: string }
  | { type: 'implementer_generate_done'; ts: number; phase: Phase; taskId: TaskId; file: string; diff?: string; linesAdded: number; linesRemoved: number; duration: number }
  | { type: 'implementer_generate_failed'; ts: number; phase: Phase; taskId: TaskId; model: string }
  // Validation
  | { type: 'validate'; ts: number; phase: Phase; taskId: TaskId; status: 'running' | 'done'; passed: boolean; stages: ValidationStages; error?: string; duration?: number }
  // Escalation
  | { type: 'escalate'; ts: number; phase: Phase; taskId: TaskId; tier: 0 | 1 | 2; hint?: string; tool?: string; model?: string }
  // Git
  | { type: 'git_commit'; ts: number; phase: Phase; taskId: TaskId; message: string; file?: string }
  | { type: 'git_checkpoint'; ts: number; phase: Phase; taskId: TaskId; tag: string }
  // Clarifications
  | { type: 'clarifications_collected'; ts: number; phase: Phase; count: number; clarifications: Array<{ question: string; answer: string }> }
  | { type: 'clarification_answered'; ts: number; phase: Phase; questionId?: string; answer: string }
  // Queue
  | { type: 'message_queued'; ts: number; phase: Phase; id: string }
  | { type: 'message_injected_native'; ts: number; phase: Phase; id: string }
  | { type: 'queue_drained'; ts: number; phase: Phase; count: number }
  | { type: 'queue_cleared'; ts: number; phase: Phase; count: number }
  | { type: 'user_message'; ts: number; phase: Phase; text: string }
  // Cost & budget
  | { type: 'cost_update'; ts: number; phase: Phase; tokenUsage: TokenUsage }
  | { type: 'cost_prediction'; ts: number; phase: Phase; prediction: CostPrediction }
  | { type: 'budget_warning'; ts: number; phase: Phase; currentCost: number; maxBudget: number }
  | { type: 'budget_exceeded'; ts: number; phase: Phase; currentCost: number; maxBudget: number }
  // Generic
  | { type: 'warning'; ts: number; phase: Phase; message: string }
  | { type: 'error'; ts: number; phase: Phase; message: string };

export type EngineEventOf<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

export type EventSink = (event: EngineEvent) => void;

export interface EventBus {
  publish(event: EngineEvent): void;
  subscribe(sink: EventSink): () => void;
}

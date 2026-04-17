import type { Phase, TaskId } from './state-actions.js';
import type { TaskCompletionMethod } from './summary.js';

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
  clarification_answered: { questionId?: string | undefined; answer: string };
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

export type SessionLogEventEntryFor<T extends OrchestratorEventType> = {
  ts: string;
  kind: 'event';
  type: T;
  taskId?: TaskId | undefined;
  phase: Phase;
  data: OrchestratorEventPayloadMap[T];
};

export type SessionLogEventEntry = {
  [K in OrchestratorEventType]: SessionLogEventEntryFor<K>;
}[OrchestratorEventType];

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

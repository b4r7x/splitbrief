import type { EngineEvent } from '../../../../engine/events/types.js';

const TRANSCRIPT_ROWLESS_EVENT_TYPES = [
  'workflow_started',
  'workflow_resumed',
  'workflow_complete',
  'workflow_config',
  'spec_approved',
  'spec_rejected',
  'spec_regenerated',
  'plan_approved',
  'plan_rejected',
  'plan_regenerated',
  'briefs_approved',
  'briefs_rejected',
  'all_tasks_done',
  'planner_status',
  'planner_heartbeat',
  'steerable_call',
  'drift_chain_detected',
  'approval_mode_changed',
  'snapshot_created',
  'snapshot_restored',
  'snapshot_restore_conflict',
  'mode_resolved',
  'mode_advice',
  'instant_plan_received',
  'tasks_planned',
  'task_completed',
  'task_escalating',
  'task_scope_widened',
  'task_tokens',
  'task_review_needed',
  'review_started',
  'review_completed',
  'review_fix_started',
  'hint_failed',
  'task_replaced',
  'tasks_inserted',
  'checks_run',
  'seat_wait_started',
  'seat_retry',
  'no_progress_cut',
  'consult_bound_spent',
  'cost_update',
  'workspace_closed',
  'approval_prompted',
  'approval_granted',
  'approval_rejected',
  'approval_sticky_recorded',
  'replay_started',
  'replay_complete',
  'clarifications_collected',
  'clarification_answered',
  'runner_call_stalled',
  'runner_call_stall_cleared',
  'runner_call_runtime_status',
  'runner_call_heartbeat',
] as const satisfies readonly EngineEvent['type'][];

type TranscriptRowlessEvent =
  | Extract<EngineEvent, { type: (typeof TRANSCRIPT_ROWLESS_EVENT_TYPES)[number] }>
  | (Extract<EngineEvent, { type: 'runner_call_activity' }> & { kind: 'session' });

const transcriptRowlessEventTypes: ReadonlySet<string> = new Set(TRANSCRIPT_ROWLESS_EVENT_TYPES);

export function isTranscriptRowlessEvent(event: EngineEvent): event is TranscriptRowlessEvent {
  return (
    transcriptRowlessEventTypes.has(event.type) ||
    (event.type === 'runner_call_activity' && event.kind === 'session')
  );
}

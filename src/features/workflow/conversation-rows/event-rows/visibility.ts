import type { EngineEvent } from '../../../../engine/events/types.js';

const TRANSCRIPT_ROWLESS_EVENT_TYPES = [
  'workflow_started',
  'workflow_resumed',
  'workflow_complete',
  'workflow_config',
  'spec_rejected',
  'spec_regenerated',
  'plan_approved',
  'plan_rejected',
  'plan_regenerated',
  'all_tasks_done',
  'planner_status',
  'planner_heartbeat',
  'drift_chain_detected',
  'snapshot_created',
  'snapshot_restored',
  'snapshot_restore_conflict',
  'mode_resolved',
  'mode_advice',
  'instant_plan_received',
  'task_completed',
  'task_escalating',
  'task_tokens',
  'task_review_needed',
  'hint_failed',
  'cost_update',
  'approval_prompted',
  'approval_granted',
  'approval_rejected',
  'approval_sticky_recorded',
  'ipc_server_started',
  'ipc_client_attached',
  'ipc_client_detached',
  'ipc_reconnect_attempt',
  'ipc_reconnect_failed',
  'replay_started',
  'replay_complete',
  'clarifications_collected',
  'clarification_answered',
  'runner_call_stalled',
  'runner_call_stall_cleared',
] as const satisfies readonly EngineEvent['type'][];

type TranscriptRowlessEventType = (typeof TRANSCRIPT_ROWLESS_EVENT_TYPES)[number];

const transcriptRowlessEventTypes: ReadonlySet<string> = new Set(TRANSCRIPT_ROWLESS_EVENT_TYPES);

export function isTranscriptRowlessEvent(
  event: EngineEvent,
): event is Extract<EngineEvent, { type: TranscriptRowlessEventType }> {
  return transcriptRowlessEventTypes.has(event.type);
}

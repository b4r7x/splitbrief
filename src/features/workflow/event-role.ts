import { phaseRole } from '../../core/phases.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { assertNever } from '../../utils/type-guards.js';

export type GutterRole = 'planner' | 'implementer' | null;

export function getGutterRole(event: EngineEvent): GutterRole {
  switch (event.type) {
    case 'planner_status': return phaseRole(event.phase);
    case 'planner_text': case 'planner_heartbeat': case 'task_started': case 'escalate': return 'planner';
    case 'implementer_generate_running': case 'implementer_generate_done':
    case 'implementer_generate_failed': case 'validate':
    case 'git_commit': case 'git_checkpoint': case 'git_branch_created': case 'task_retry': return 'implementer';
    case 'warning': case 'error': case 'task_completed': case 'task_skipped':
    case 'cost_update': case 'cost_prediction': case 'budget_warning':
    case 'budget_paused': case 'budget_exceeded': case 'workflow_cancelled': case 'workflow_config':
    case 'rewind_to_spec': case 'rewind_to_plan': case 'task_reset':
    case 'task_review_needed':
    case 'message_queued': case 'message_injected_native':
    case 'queue_drained': case 'queue_cleared':
    case 'user_message':
    case 'planner_attachments_dropped':
    case 'workflow_started': case 'workflow_resumed': case 'workflow_complete':
    case 'paused_external_changes':
    case 'recovery_prompted':
    case 'recovery_action_selected':
    case 'recovery_action_failed':
    case 'recovery_resolved':
    case 'spec_rejected':
    case 'spec_regenerated': case 'plan_approved': case 'plan_rejected':
    case 'plan_regenerated': case 'all_tasks_done':
    case 'task_escalating': case 'task_full_fail':
    case 'task_tokens': case 'hint_failed':
    case 'mode_resolved': case 'mode_downgrade_advised': case 'mode_advice': case 'instant_plan_received':
    case 'clarifications_collected': case 'clarification_answered':
    case 'brief_quality_passed': case 'brief_quality_failed':
    case 'drift_report':
    case 'drift_chain_detected':
    case 'snapshot_created':
    case 'snapshot_restored':
    case 'snapshot_restore_conflict':
    case 'approval_prompted':
    case 'approval_granted':
    case 'approval_rejected':
    case 'approval_sticky_recorded':
    case 'approval_mode_changed':
    case 'ipc_server_started':
    case 'ipc_client_attached':
    case 'ipc_client_detached':
    case 'ipc_reconnect_attempt':
    case 'ipc_reconnect_failed':
    case 'replay_started':
    case 'replay_complete': return null;
    default: return assertNever(event);
  }
}

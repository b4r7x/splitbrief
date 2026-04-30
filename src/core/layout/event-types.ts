import type { TaskCompletionMethod } from '../schemas/enums.js';
import type { CostPrediction } from '../schemas/summary.js';

type EventOf<TType extends string, TPayload extends object = Record<never, never>> =
  TType extends TType ? { type: TType; ts?: number; phase?: string } & TPayload : never;

type EmptyLayoutEvent = EventOf<
  | 'workflow_started'
  | 'workflow_resumed'
  | 'workflow_complete'
  | 'workflow_config'
  | 'research_done'
  | 'spec_done'
  | 'spec_approved'
  | 'spec_rejected'
  | 'spec_regenerated'
  | 'plan_done'
  | 'plan_approved'
  | 'plan_rejected'
  | 'plan_regenerated'
  | 'all_tasks_done'
  | 'drift_chain_detected'
  | 'snapshot_created'
  | 'snapshot_restored'
  | 'snapshot_restore_conflict'
  | 'mode_resolved'
  | 'mode_advice'
  | 'instant_plan_received'
  | 'task_failed'
  | 'task_escalating'
  | 'task_full_fail'
  | 'task_tokens'
  | 'task_review_needed'
  | 'hint_failed'
  | 'implementer_generate_running'
  | 'implementer_generate_failed'
  | 'git_commit'
  | 'git_checkpoint'
  | 'git_branch_created'
  | 'clarifications_collected'
  | 'clarification_answered'
  | 'message_queued'
  | 'message_injected_native'
  | 'queue_drained'
  | 'queue_cleared'
  | 'planner_attachment_added'
  | 'planner_attachments_dropped'
  | 'cost_update'
  | 'budget_warning'
  | 'budget_paused'
  | 'budget_exceeded'
  | 'approval_prompted'
  | 'approval_granted'
  | 'approval_rejected'
  | 'approval_sticky_recorded'
  | 'approval_mode_changed'
  | 'ipc_server_started'
  | 'ipc_client_attached'
  | 'ipc_client_detached'
  | 'ipc_reconnect_attempt'
  | 'ipc_reconnect_failed'
  | 'server_crash_detected'
  | 'server_post_mortem_shown'
  | 'replay_started'
  | 'replay_complete'
>;

export type LayoutEvent =
  | EmptyLayoutEvent
  | EventOf<'workflow_cancelled'>
  | EventOf<'paused_external_changes'>
  | EventOf<'recovery_prompted'>
  | EventOf<'recovery_action_selected'>
  | EventOf<'recovery_action_failed'>
  | EventOf<'recovery_resolved'>
  | EventOf<'planner_status'>
  | EventOf<'planner_text', { text: string }>
  | EventOf<'rewind_to_spec'>
  | EventOf<'rewind_to_plan'>
  | EventOf<'brief_quality_passed'>
  | EventOf<'brief_quality_failed'>
  | EventOf<'drift_report'>
  | EventOf<'mode_downgrade_advised'>
  | EventOf<'task_started', { taskId: string; index: number; title: string; file: string }>
  | EventOf<'task_completed', { taskId: string; method: TaskCompletionMethod; retries: number; duration: number }>
  | EventOf<'task_skipped', { taskId: string; reason: string }>
  | EventOf<'task_reset'>
  | EventOf<'implementer_generate_done', { diff?: string | undefined }>
  | EventOf<'validate', { status: string; error?: string | undefined }>
  | EventOf<'task_retry'>
  | EventOf<'escalate', { hint?: string | undefined }>
  | EventOf<'user_message', { text: string }>
  | EventOf<'warning', { message: string }>
  | EventOf<'error', { message: string }>
  | EventOf<'cost_prediction', { prediction?: CostPrediction | undefined }>;

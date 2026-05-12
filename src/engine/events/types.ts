import type { TaskId } from '../../core/schemas/task.js';
import type { ApproveLevel, Phase, RecoveryAction, RecoveryReason, TaskCompletionMethod, WorkflowMode } from '../../core/schemas/enums.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { ActionClass } from '../../core/schemas/enums.js';
import type { ApprovalTier } from '../../core/schemas/config.js';
import type { UserEditConflict, UserEditConflictAction } from './workflow-events.js';
import type { CurrentCodeContextMode, TaskContextFit } from './workflow-events.js';
import type { TaskReviewRequest } from './workflow-events.js';

export type ValidationStages = { typecheck: boolean; lint: boolean; test: boolean };

export type EngineEvent =
  | { type: 'workflow_started'; ts: number; phase: Phase; feature: string }
  | { type: 'workflow_resumed'; ts: number; phase: Phase }
  | { type: 'workflow_complete'; ts: number; phase: Phase }
  | { type: 'workflow_cancelled'; ts: number; phase: Phase }
  | { type: 'workflow_config'; ts: number; phase: Phase; mode: WorkflowMode; plannerTool: string; plannerModel?: string; implementerTool: string; implementerModel?: string }
  | { type: 'paused_external_changes'; ts: number; phase: Phase; conflict?: UserEditConflict; selectedAction?: UserEditConflictAction }
  | { type: 'recovery_prompted'; ts: number; phase: Phase; issueId: string; reason: RecoveryReason; taskId?: TaskId; files: string[]; affectedTaskIds: TaskId[]; availableActions: RecoveryAction[]; recommendedAction: RecoveryAction }
  | { type: 'recovery_action_selected'; ts: number; phase: Phase; issueId: string; reason: RecoveryReason; action: RecoveryAction }
  | { type: 'recovery_action_failed'; ts: number; phase: Phase; issueId: string; reason: RecoveryReason; action: RecoveryAction; message: string }
  | { type: 'recovery_resolved'; ts: number; phase: Phase; issueId: string; reason: RecoveryReason; action: RecoveryAction; outcome: 'continued' | 'retry-current-task' | 'skipped-current-task' | 'aborted'; implementerProfile?: string }
  | { type: 'planner_status'; ts: number; phase: Phase; status: 'running' | 'done'; tool?: string; model?: string; duration?: number; summary?: string }
  | { type: 'planner_text'; ts: number; phase: Phase; text: string }
  | { type: 'planner_heartbeat'; ts: number; phase: Phase; elapsedMs: number; accumulatedTokens: number; phaseHint?: string }
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
  | { type: 'brief_quality_passed'; ts: number; phase: Phase; score: number; warningCount: number }
  | { type: 'brief_quality_failed'; ts: number; phase: Phase; score: number; errorCount: number; warningCount: number }
  | { type: 'drift_report'; ts: number; phase: Phase; passed: boolean; score: number; errorCount: number; warningCount: number }
  | { type: 'drift_chain_detected'; ts: number; phase: Phase; chainLength: number; score: number; threshold: number; uniqueOutOfBoundsFiles: string[]; representativePath: string }
  | { type: 'snapshot_created'; ts: number; phase: Phase; snapshotId: string; name?: string; fileCount: number; taskIndex?: number }
  | { type: 'snapshot_restored'; ts: number; snapshotId: string; restoredCount: number; conflictedCount: number; forcedCount: number; forced: boolean }
  | { type: 'snapshot_restore_conflict'; ts: number; snapshotId: string; conflictedPaths: string[] }
  | { type: 'mode_resolved'; ts: number; phase: Phase; mode: WorkflowMode; approve: ApproveLevel }
  | { type: 'mode_downgrade_advised'; ts: number; phase: Phase; currentMode: WorkflowMode; suggestedMode: WorkflowMode }
  | { type: 'mode_advice'; ts: number; phase: Phase; kind: 'none' | 'downgrade' | 'upgrade' | 'missing-context'; risk: 'trivial' | 'small' | 'normal' | 'high'; currentMode: WorkflowMode; suggestedMode: WorkflowMode; confidence: number; factors: string[]; missing: string[] }
  | { type: 'instant_plan_received'; ts: number; phase: Phase; taskCount: number }
  | { type: 'task_started'; ts: number; phase: Phase; taskId: TaskId; title: string; index: number; total: number; file: string; action: 'create' | 'modify'; tool?: string; model?: string; implementerProfile?: string; contextFit?: TaskContextFit; estimatedTokens?: number; untruncatedEstimatedTokens?: number; contextLength?: number; currentCodeTruncated?: boolean; currentCodeContextMode?: CurrentCodeContextMode; costPosture?: string; routingReason?: string }
  | { type: 'task_completed'; ts: number; phase: Phase; taskId: TaskId; title: string; method: TaskCompletionMethod; retries: number; duration: number; tool?: string; model?: string; implementerProfile?: string }
  | { type: 'task_failed'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'task_skipped'; ts: number; phase: Phase; taskId: TaskId; title: string; reason: string }
  | { type: 'task_retry'; ts: number; phase: Phase; taskId: TaskId; attempt: number; maxRetries: number; error: string }
  | { type: 'task_escalating'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'task_full_fail'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'task_reset'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'task_tokens'; ts: number; phase: Phase; taskId: TaskId; method: TaskCompletionMethod; implementerTokens: number; escalationTokens: number; retryCount: number; tool?: string; model?: string; implementerProfile?: string; contextFit?: TaskContextFit; estimatedTokens?: number; untruncatedEstimatedTokens?: number; contextLength?: number; currentCodeTruncated?: boolean; currentCodeContextMode?: CurrentCodeContextMode; costPosture?: string; routingReason?: string }
  | ({ type: 'task_review_needed'; ts: number; phase: Phase } & TaskReviewRequest)
  | { type: 'hint_failed'; ts: number; phase: Phase; taskId: TaskId }
  | { type: 'implementer_generate_running'; ts: number; phase: Phase; taskId: TaskId; file?: string }
  | { type: 'implementer_generate_done'; ts: number; phase: Phase; taskId: TaskId; file: string; diff?: string; linesAdded: number; linesRemoved: number; duration: number }
  | { type: 'implementer_generate_failed'; ts: number; phase: Phase; taskId: TaskId; model: string }
  | { type: 'validate'; ts: number; phase: Phase; taskId: TaskId; status: 'running' | 'done'; passed: boolean; stages: ValidationStages; error?: string; duration?: number }
  | { type: 'escalate'; ts: number; phase: Phase; taskId: TaskId; tier: 0 | 1 | 2; hint?: string; tool?: string; model?: string }
  | { type: 'git_commit'; ts: number; phase: Phase; taskId: TaskId; message: string; file?: string }
  | { type: 'git_checkpoint'; ts: number; phase: Phase; taskId: TaskId; tag: string }
  | { type: 'git_branch_created'; ts: number; phase: Phase; name: string }
  | { type: 'clarifications_collected'; ts: number; phase: Phase; count: number; clarifications: Array<{ question: string; answer: string }> }
  | { type: 'clarification_answered'; ts: number; phase: Phase; questionId?: string; answer: string }
  | { type: 'message_queued'; ts: number; phase: Phase; id: string }
  | { type: 'message_injected_native'; ts: number; phase: Phase; id: string }
  | { type: 'queue_drained'; ts: number; phase: Phase; count: number }
  | { type: 'queue_cleared'; ts: number; phase: Phase; count: number }
  | { type: 'user_message'; ts: number; phase: Phase; text: string }
  | { type: 'planner_attachment_added'; ts: number; phase: Phase; id: string; path: string; sizeBytes: number }
  | { type: 'planner_attachments_dropped'; ts: number; phase: Phase; count: number; reason: 'unsupported-backend' | 'capability-degraded' }
  | { type: 'cost_update'; ts: number; phase: Phase; tokenUsage: TokenUsage }
  | { type: 'cost_prediction'; ts: number; phase: Phase; prediction: CostPrediction }
  | { type: 'budget_warning'; ts: number; phase: Phase; currentCost: number; maxBudget: number }
  | { type: 'budget_paused'; ts: number; phase: Phase; currentCost: number; maxBudget: number; threshold: number }
  | { type: 'budget_exceeded'; ts: number; phase: Phase; currentCost: number; maxBudget: number }
  | { type: 'approval_prompted'; ts: number; phase: Phase; tier: ApprovalTier; actionClass: ActionClass; taskId?: TaskId }
  | { type: 'approval_granted'; ts: number; phase: Phase; tier: ApprovalTier; actionClass: ActionClass; taskId?: TaskId; scope: 'once' | 'session' | 'always'; confirmReason?: string }
  | { type: 'approval_rejected'; ts: number; phase: Phase; tier: ApprovalTier; actionClass: ActionClass; taskId?: TaskId; reason: string }
  | { type: 'approval_sticky_recorded'; ts: number; phase: Phase; pattern: string; scope: 'session' | 'always'; actionClass: ActionClass }
  | { type: 'approval_mode_changed'; ts: number; mode: 'yolo' | 'normal' }
  | { type: 'ipc_server_started'; ts: number; phase: Phase; sockPath: string }
  | { type: 'ipc_client_attached'; ts: number; phase: Phase }
  | { type: 'ipc_client_detached'; ts: number; phase: Phase }
  | { type: 'ipc_reconnect_attempt'; ts: number; phase: Phase; attempt: number; maxAttempts: number }
  | { type: 'ipc_reconnect_failed'; ts: number; phase: Phase }
  | { type: 'server_crash_detected'; ts: number; phase: Phase; sessionId: string; pid: number | null; signal: string | null }
  | { type: 'server_post_mortem_shown'; ts: number; phase: Phase; sessionId: string }
  | { type: 'replay_started'; ts: number; phase: Phase; totalEvents: number }
  | { type: 'replay_complete'; ts: number; phase: Phase; totalEvents: number; durationMs: number }
  | { type: 'warning'; ts: number; phase: Phase; message: string }
  | { type: 'error'; ts: number; phase: Phase; message: string };

export type EngineEventOf<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

export type EventSink = (event: EngineEvent) => void;

export interface EventBus {
  publish(event: EngineEvent): void;
  subscribe(sink: EventSink): () => void;
}

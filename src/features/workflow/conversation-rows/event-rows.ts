import { formatCost } from '../../../core/formatting.js';
import { formatModelName } from '../../../core/model-display.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { assertNever } from '../../../utils/type-guards.js';
import { getGutterRole } from '../event-role.js';
import { costPredictionRows } from './cost-prediction-rows.js';
import { formatExternalChangesValue, formatTaskStartedValue, validationRow } from './event-format.js';
import { implementerDoneRows, runningImplementerRows } from './implementer-rows.js';
import type { ConversationRow, RowBuildContext } from './types.js';
import { cardRows, prefixedWrappedRows, row, rowText, wrapRows } from './row-format.js';

export function eventRows(
  event: EngineEvent,
  globalIndex: number,
  ctx: RowBuildContext,
  expanded: boolean,
): ConversationRow[] {
  const keyPrefix = `event-${globalIndex}-${event.type}`;
  const role = getGutterRole(event);

  switch (event.type) {
    case 'workflow_started':
    case 'workflow_resumed':
    case 'workflow_complete':
    case 'workflow_config':
    case 'spec_rejected':
    case 'spec_regenerated':
    case 'plan_approved':
    case 'plan_rejected':
    case 'plan_regenerated':
    case 'all_tasks_done':
    case 'planner_status':
    case 'planner_heartbeat':
    case 'drift_chain_detected':
    case 'snapshot_created':
    case 'snapshot_restored':
    case 'snapshot_restore_conflict':
    case 'mode_resolved':
    case 'mode_advice':
    case 'instant_plan_received':
    case 'task_completed':
    case 'task_escalating':
    case 'task_full_fail':
    case 'task_tokens':
    case 'task_review_needed':
    case 'hint_failed':
    case 'cost_update':
    case 'approval_prompted':
    case 'approval_granted':
    case 'approval_rejected':
    case 'approval_sticky_recorded':
    case 'ipc_server_started':
    case 'ipc_client_attached':
    case 'ipc_client_detached':
    case 'ipc_reconnect_attempt':
    case 'ipc_reconnect_failed':
    case 'replay_started':
    case 'replay_complete':
    case 'clarifications_collected':
    case 'clarification_answered':
      return [];
    case 'workflow_cancelled':
      return [
        row(`${keyPrefix}-title`, 'Workflow cancelled', 'warning', true),
        row(`${keyPrefix}-resume`, 'Resume with: diptych resume', 'textDim'),
      ];
    case 'paused_external_changes':
      return cardRows(keyPrefix, 'user edits', formatExternalChangesValue(event), ctx.width, event.conflict?.safeToContinue ? 'warning' : 'error');
    case 'recovery_prompted':
      return cardRows(keyPrefix, 'recovery', `${event.reason}${event.taskId ? ` · ${event.taskId}` : ''} · recommended ${event.recommendedAction}`, ctx.width, 'warning', 'warning');
    case 'recovery_action_selected':
      return cardRows(keyPrefix, 'recovery', `selected ${event.action} for ${event.reason}`, ctx.width, 'info');
    case 'recovery_action_failed':
      return cardRows(keyPrefix, 'recovery', `${event.action} blocked: ${event.message}`, ctx.width, 'error', 'error');
    case 'recovery_resolved':
      return cardRows(keyPrefix, 'recovery', `${event.outcome} via ${event.action}${event.implementerProfile ? ` · ${event.implementerProfile}` : ''}`, ctx.width, 'success');
    case 'planner_text':
      return prefixedWrappedRows(keyPrefix, event.text, ctx.width, 'text', role);
    case 'rewind_to_spec':
      return cardRows(keyPrefix, 'rewind → spec', event.comment || undefined, ctx.width, 'warning');
    case 'rewind_to_plan':
      return cardRows(keyPrefix, 'rewind → plan', event.comment || undefined, ctx.width, 'warning');
    case 'brief_quality_passed':
      return cardRows(keyPrefix, 'brief quality', `score ${event.score.toFixed(2)} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`, ctx.width, 'success');
    case 'brief_quality_failed':
      return cardRows(keyPrefix, 'brief quality', `score ${event.score.toFixed(2)} · ${event.errorCount} error${event.errorCount === 1 ? '' : 's'} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`, ctx.width, 'error', 'error');
    case 'drift_report':
      return cardRows(keyPrefix, 'drift', `score ${event.score.toFixed(2)} · ${event.errorCount} error${event.errorCount === 1 ? '' : 's'} · ${event.warningCount} warning${event.warningCount === 1 ? '' : 's'}`, ctx.width, event.passed ? 'success' : 'warning', event.passed ? 'textDim' : 'warning');
    case 'mode_downgrade_advised':
      return wrapRows([row(keyPrefix, `This looks trivial. Consider --mode ${event.suggestedMode} instead of --mode ${event.currentMode}.`, 'warning')], ctx.width);
    case 'task_started':
      return prefixedWrappedRows(keyPrefix, `T${event.index + 1}: ${event.title}  ${formatTaskStartedValue(event)}`, ctx.width, 'text', role, true);
    case 'task_skipped':
      return cardRows(keyPrefix, 'skipped', `T${event.taskId} ${event.title}: ${event.reason}`, ctx.width, 'textDim');
    case 'task_retry':
      return prefixedWrappedRows(keyPrefix, `retry  attempt ${event.attempt}/${event.maxRetries}`, ctx.width, 'warning', role);
    case 'task_reset':
      return cardRows(keyPrefix, 'task reset', `Task ${event.taskId} set to pending`, ctx.width, 'warning');
    case 'implementer_generate_running':
      return runningImplementerRows(keyPrefix, event, ctx.streaming)
        .flatMap((sourceRow, index) => prefixedWrappedRows(`${sourceRow.key}-${index}`, rowText(sourceRow), ctx.width, sourceRow.segments[0]?.tone ?? 'text', role));
    case 'implementer_generate_done':
      return implementerDoneRows(keyPrefix, event, ctx, expanded)
        .flatMap((sourceRow, index) => prefixedWrappedRows(`${sourceRow.key}-${index}`, rowText(sourceRow), ctx.width, sourceRow.segments[0]?.tone ?? 'text', role));
    case 'implementer_generate_failed':
      return prefixedWrappedRows(keyPrefix, `${formatModelName(event.model)}  failed`, ctx.width, 'error', role);
    case 'validate': {
      const rows = prefixedWrappedRows(keyPrefix, validationRow(event), ctx.width, event.passed ? 'success' : 'validator', role);
      if (event.status === 'done' && !event.passed && event.error) {
        rows.push(...prefixedWrappedRows(`${keyPrefix}-error`, `  ${event.error}`, ctx.width, 'error', role));
      }
      return rows;
    }
    case 'escalate': {
      const rows = prefixedWrappedRows(keyPrefix, `escalate tier ${event.tier}${event.hint ? ' — hint' : ''}`, ctx.width, 'planner', role, true);
      if (event.hint) rows.push(...prefixedWrappedRows(`${keyPrefix}-hint`, `  ${event.hint}`, ctx.width, 'textDim', role));
      return rows;
    }
    case 'git_commit':
      return cardRows(keyPrefix, 'committed', event.message, ctx.width, 'success');
    case 'git_checkpoint':
      return cardRows(keyPrefix, 'checkpoint', event.tag, ctx.width, 'success');
    case 'git_branch_created':
      return cardRows(keyPrefix, 'branch', event.name, ctx.width, 'success');
    case 'message_queued':
      return cardRows(keyPrefix, 'queued', `Message queued during ${event.phase}`, ctx.width, 'info');
    case 'message_injected_native':
      return cardRows(keyPrefix, 'injected', 'Message delivered to live session', ctx.width, 'success');
    case 'queue_drained':
      return cardRows(keyPrefix, 'drained', `${event.count} queued message${event.count === 1 ? '' : 's'} folded into next prompt`, ctx.width, 'info');
    case 'queue_cleared':
      return cardRows(keyPrefix, 'queue cleared', `${event.count} pending message${event.count === 1 ? '' : 's'} removed`, ctx.width, 'warning');
    case 'user_message':
      return wrapRows([row(keyPrefix, `❯ ${event.text}`, 'accent', true)], ctx.width);
    case 'planner_attachments_dropped':
      return cardRows(keyPrefix, 'attachments dropped', `${event.count} image${event.count === 1 ? '' : 's'} dropped (${event.reason})`, ctx.width, 'warning', 'warning');
    case 'warning':
      return cardRows(keyPrefix, 'warning', event.message, ctx.width, 'warning', 'warning');
    case 'error':
      return cardRows(keyPrefix, 'error', event.message, ctx.width, 'error', 'error');
    case 'cost_prediction':
      return costPredictionRows(keyPrefix, event, ctx.width);
    case 'budget_warning':
      return cardRows(keyPrefix, 'budget', `80% reached: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`, ctx.width, 'warning', 'warning');
    case 'budget_paused':
      return cardRows(keyPrefix, 'budget', `Paused: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`, ctx.width, 'warning', 'warning');
    case 'budget_exceeded':
      return cardRows(keyPrefix, 'budget', `Exceeded: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`, ctx.width, 'error', 'error');
    case 'approval_mode_changed':
      return cardRows(keyPrefix, 'approval', event.mode === 'yolo' ? 'tiered approvals disabled' : 'tiered approvals restored', ctx.width, event.mode === 'yolo' ? 'warning' : 'textDim', event.mode === 'yolo' ? 'warning' : 'textDim');
    default:
      return assertNever(event);
  }
}

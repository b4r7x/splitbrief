import { formatCost, formatScoreSummary } from '../../../core/formatting.js';
import { formatModelName } from '../../../core/model-display.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import { assertNever } from '../../../utils/type-guards.js';
import { getGutterRole } from './event-role.js';
import { costPredictionRows } from './cost-prediction-rows.js';
import {
  formatExternalChangesValue,
  formatTaskStartedValue,
  validationRow,
} from './event-format.js';
import { implementerDoneRows, runningImplementerRows } from './implementer-rows.js';
import type { ConversationRow, RowBuildContext } from './types.js';
import { cardRows, prefixedWrappedRows, row, rowText, wrapRows } from './row-format.js';

export function eventRows(options: {
  event: EngineEvent;
  globalIndex: number;
  ctx: RowBuildContext;
  expanded: boolean;
}): ConversationRow[] {
  const { event, globalIndex, ctx, expanded } = options;
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
      return [row(`${keyPrefix}-title`, 'Workflow cancelled', 'warning', true)];
    case 'paused_external_changes':
      return cardRows({
        keyPrefix,
        label: 'user edits',
        value: formatExternalChangesValue(event),
        width: ctx.width,
        labelTone: event.conflict?.safeToContinue ? 'warning' : 'error',
      });
    case 'recovery_prompted':
      return cardRows({
        keyPrefix,
        label: 'recovery',
        value: `${event.reason}${event.taskId ? ` · ${event.taskId}` : ''} · recommended ${event.recommendedAction}`,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'recovery_action_selected':
      return cardRows({
        keyPrefix,
        label: 'recovery',
        value: `selected ${event.action} for ${event.reason}`,
        width: ctx.width,
        labelTone: 'info',
      });
    case 'recovery_action_failed':
      return cardRows({
        keyPrefix,
        label: 'recovery',
        value: `${event.action} blocked: ${event.message}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'error',
      });
    case 'recovery_resolved':
      return cardRows({
        keyPrefix,
        label: 'recovery',
        value: `${event.outcome} via ${event.action}${event.implementerProfile ? ` · ${event.implementerProfile}` : ''}`,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'planner_text':
      return prefixedWrappedRows({
        keyPrefix,
        text: event.text,
        width: ctx.width,
        tone: 'text',
        role,
      });
    case 'rewind_to_spec':
      return cardRows({
        keyPrefix,
        label: 'rewind → spec',
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'warning',
      });
    case 'rewind_to_plan':
      return cardRows({
        keyPrefix,
        label: 'rewind → plan',
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'warning',
      });
    case 'brief_quality_passed':
      return cardRows({
        keyPrefix,
        label: 'brief quality',
        value: formatScoreSummary(event.score, { errorCount: 0, warningCount: event.warningCount }),
        width: ctx.width,
        labelTone: 'success',
      });
    case 'brief_quality_failed':
      return cardRows({
        keyPrefix,
        label: 'brief quality',
        value: formatScoreSummary(event.score, {
          errorCount: event.errorCount,
          warningCount: event.warningCount,
        }),
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'error',
      });
    case 'drift_report':
      return cardRows({
        keyPrefix,
        label: 'drift',
        value: formatScoreSummary(event.score, {
          errorCount: event.errorCount,
          warningCount: event.warningCount,
        }),
        width: ctx.width,
        labelTone: event.passed ? 'success' : 'warning',
        valueTone: event.passed ? 'textDim' : 'warning',
      });
    case 'mode_downgrade_advised':
      return wrapRows(
        [
          row(
            keyPrefix,
            `This looks trivial. Consider --mode ${event.suggestedMode} instead of --mode ${event.currentMode}.`,
            'warning',
          ),
        ],
        ctx.width,
      );
    case 'task_started':
      return prefixedWrappedRows({
        keyPrefix,
        text: `T${event.index + 1}: ${event.title}  ${formatTaskStartedValue(event)}`,
        width: ctx.width,
        tone: 'text',
        role,
        bold: true,
      });
    case 'task_skipped':
      return cardRows({
        keyPrefix,
        label: 'skipped',
        value: `T${event.taskId} ${event.title}: ${event.reason}`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'task_retry':
      return prefixedWrappedRows({
        keyPrefix,
        text: `retry  attempt ${event.attempt}/${event.maxRetries}`,
        width: ctx.width,
        tone: 'warning',
        role,
      });
    case 'task_reset':
      return cardRows({
        keyPrefix,
        label: 'task reset',
        value: `Task ${event.taskId} set to pending`,
        width: ctx.width,
        labelTone: 'warning',
      });
    case 'implementer_generate_running':
      return runningImplementerRows(keyPrefix, event, ctx.streaming).flatMap((sourceRow, index) =>
        prefixedWrappedRows({
          keyPrefix: `${sourceRow.key}-${index}`,
          text: rowText(sourceRow),
          width: ctx.width,
          tone: sourceRow.segments[0]?.tone ?? 'text',
          role,
        }),
      );
    case 'implementer_generate_done':
      return implementerDoneRows(keyPrefix, event, ctx, expanded).flatMap((sourceRow, index) =>
        prefixedWrappedRows({
          keyPrefix: `${sourceRow.key}-${index}`,
          text: rowText(sourceRow),
          width: ctx.width,
          tone: sourceRow.segments[0]?.tone ?? 'text',
          role,
        }),
      );
    case 'implementer_generate_failed':
      return prefixedWrappedRows({
        keyPrefix,
        text: `${formatModelName(event.model)}  failed`,
        width: ctx.width,
        tone: 'error',
        role,
      });
    case 'validate': {
      const rows = prefixedWrappedRows({
        keyPrefix,
        text: validationRow(event),
        width: ctx.width,
        tone: event.passed ? 'success' : 'validator',
        role,
      });
      if (event.status === 'done' && !event.passed && event.error) {
        rows.push(
          ...prefixedWrappedRows({
            keyPrefix: `${keyPrefix}-error`,
            text: `  ${event.error}`,
            width: ctx.width,
            tone: 'error',
            role,
          }),
        );
      }
      return rows;
    }
    case 'escalate': {
      const rows = prefixedWrappedRows({
        keyPrefix,
        text: `escalate tier ${event.tier}${event.hint ? ' — hint' : ''}`,
        width: ctx.width,
        tone: 'planner',
        role,
        bold: true,
      });
      if (event.hint)
        rows.push(
          ...prefixedWrappedRows({
            keyPrefix: `${keyPrefix}-hint`,
            text: `  ${event.hint}`,
            width: ctx.width,
            tone: 'textDim',
            role,
          }),
        );
      return rows;
    }
    case 'git_commit':
      return cardRows({
        keyPrefix,
        label: 'committed',
        value: event.message,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_checkpoint':
      return cardRows({
        keyPrefix,
        label: 'checkpoint',
        value: event.tag,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_branch_created':
      return cardRows({
        keyPrefix,
        label: 'branch',
        value: event.name,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'message_queued':
      return cardRows({
        keyPrefix,
        label: 'queued',
        value: `Message queued during ${event.phase}`,
        width: ctx.width,
        labelTone: 'info',
      });
    case 'message_injected_native':
      return cardRows({
        keyPrefix,
        label: 'injected',
        value: 'Message delivered to live session',
        width: ctx.width,
        labelTone: 'success',
      });
    case 'queue_drained':
      return cardRows({
        keyPrefix,
        label: 'drained',
        value: `${event.count} queued ${pluralize(event.count, 'message')} folded into next prompt`,
        width: ctx.width,
        labelTone: 'info',
      });
    case 'queue_cleared':
      return cardRows({
        keyPrefix,
        label: 'queue cleared',
        value: `${event.count} pending ${pluralize(event.count, 'message')} removed`,
        width: ctx.width,
        labelTone: 'warning',
      });
    case 'user_message':
      return wrapRows([row(keyPrefix, `❯ ${event.text}`, 'accent', true)], ctx.width);
    case 'planner_attachments_dropped':
      return cardRows({
        keyPrefix,
        label: 'attachments dropped',
        value: `${countNoun(event.count, 'image')} dropped (${event.reason})`,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'warning':
      return cardRows({
        keyPrefix,
        label: 'warning',
        value: event.message,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'error':
      return cardRows({
        keyPrefix,
        label: 'error',
        value: event.message,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'error',
      });
    case 'cost_prediction':
      return costPredictionRows(keyPrefix, event, ctx.width);
    case 'budget_warning':
      return cardRows({
        keyPrefix,
        label: 'budget',
        value: `80% reached: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'budget_paused':
      return cardRows({
        keyPrefix,
        label: 'budget',
        value: `Paused: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        labelTone: 'warning',
        valueTone: 'warning',
      });
    case 'budget_exceeded':
      return cardRows({
        keyPrefix,
        label: 'budget',
        value: `Exceeded: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'error',
      });
    case 'approval_mode_changed':
      return cardRows({
        keyPrefix,
        label: 'approval',
        value: event.mode === 'yolo' ? 'tiered approvals disabled' : 'tiered approvals restored',
        width: ctx.width,
        labelTone: event.mode === 'yolo' ? 'warning' : 'textDim',
        valueTone: event.mode === 'yolo' ? 'warning' : 'textDim',
      });
    default:
      return assertNever(event);
  }
}

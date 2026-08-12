import { formatCost, formatScoreSummary } from '../../../../core/formatting.js';
import { formatModelName } from '../../../../core/model-display.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { pluralize, countNoun } from '../../../../utils/pluralize.js';
import { runnerActivityBatchRowBlock } from '../activity-rows.js';
import { borderedCardRowsBlock } from '../bordered-card-block.js';
import { calloutRowsBlock } from '../callout-block.js';
import { costPredictionRows } from '../cost-prediction-rows.js';
import { formatExternalChangesValue, formatTaskStartedValue } from '../event-format.js';
import type { ConversationRowBlock, ConversationRowTone, RowBuildContext } from '../types.js';
import {
  cardRowsBlock,
  compositeBlock,
  promptTextBlock,
  rowSeedsBlock,
  rowsBlock,
  wrappedTextBlock,
} from '../row-block-compose.js';
import { artifactWrittenRowBlock } from './artifact-card.js';
import { taskStartedRowBlock } from '../task-started-row-block.js';
import { isRunnerCallTranscriptRowSuppressed } from '../runner-call-classification.js';
import {
  baselineValidationRowBlock,
  escalateRowBlock,
  implementerDoneRowBlock,
  runningImplementerRowBlock,
  validateRowBlock,
} from './execution.js';
import { plannerTextRowBlock } from './planner-text.js';
import { isTranscriptRowlessEvent } from './visibility.js';

export function eventRowBlock(options: {
  event: EngineEvent;
  globalIndex: number;
  ctx: RowBuildContext;
  expanded: boolean;
  dedupTitle?: string | undefined;
}): ConversationRowBlock | null {
  const { event, globalIndex, ctx, expanded } = options;
  const keyPrefix = `event-${globalIndex}-${event.type}`;

  if (isRunnerCallTranscriptRowSuppressed(event)) return null;
  if (isTranscriptRowlessEvent(event)) return null;

  switch (event.type) {
    case 'workflow_cancelled':
      return rowSeedsBlock(keyPrefix, [
        { key: `${keyPrefix}-title`, text: 'Workflow cancelled', tone: 'textDim', bold: true },
      ]);
    case 'paused_external_changes':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'user edits',
        value: formatExternalChangesValue(event),
        width: ctx.width,
        labelTone: event.conflict?.safeToContinue ? 'textDim' : 'error',
      });
    case 'recovery_prompted':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `${event.reason}${event.taskId ? ` · ${event.taskId}` : ''} · recommended ${event.recommendedAction}`,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'recovery_action_selected':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `selected ${event.action} for ${event.reason}`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'recovery_action_failed':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `${event.action} blocked: ${event.message}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    case 'recovery_resolved':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'recovery',
        value: `${event.outcome} via ${event.action}${event.implementerProfile ? ` · ${event.implementerProfile}` : ''}`,
        width: ctx.width,
        labelTone: recoveryResolvedTone(event.outcome),
        valueTone: recoveryResolvedTone(event.outcome),
      });
    case 'planner_text':
      return plannerTextRowBlock({
        event,
        keyPrefix,
        width: ctx.width,
        dedupTitle: options.dedupTitle,
      });
    case 'rewind_to_spec':
      return cardRowsBlock({
        keyPrefix,
        label: `rewind ${glyph('connectorHandoff')} spec`,
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'rewind_to_plan':
      return cardRowsBlock({
        keyPrefix,
        label: `rewind ${glyph('connectorHandoff')} plan`,
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'brief_quality_passed':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'brief quality',
        value: `passed · ${formatScoreSummary(event.score, { errorCount: 0, warningCount: event.warningCount })}`,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'brief_quality_failed':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'brief quality',
        value: `failed · ${formatScoreSummary(event.score, {
          errorCount: event.errorCount,
          warningCount: event.warningCount,
        })}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    case 'brief_readiness_passed':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'brief readiness',
        value: `passed · ${countNoun(event.taskCount, 'task')}`,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'brief_readiness_blocked':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'brief readiness',
        value: `blocked · ${countNoun(event.blockedCount, 'task')} of ${event.taskCount}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    case 'drift_report':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'drift',
        value: formatScoreSummary(event.score, {
          errorCount: event.errorCount,
          warningCount: event.warningCount,
        }),
        width: ctx.width,
        labelTone: event.passed ? 'success' : 'textDim',
        valueTone: 'textDim',
      });
    case 'task_started':
      return taskStartedRowBlock({
        keyPrefix,
        index: event.index,
        title: event.title,
        metadata: formatTaskStartedValue(event),
        width: ctx.width,
      });
    case 'task_skipped':
      return cardRowsBlock({
        keyPrefix,
        label: 'skipped',
        value: `${event.taskId} ${event.title}: ${event.reason}`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'task_full_fail':
      return cardRowsBlock({
        keyPrefix,
        label: 'task failed',
        value: event.taskId,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
        kind: 'summary',
      });
    case 'task_retry':
      return wrappedTextBlock({
        keyPrefix,
        text: `retry  attempt ${event.attempt}/${event.maxRetries}`,
        width: ctx.width,
        tone: 'textDim',
      });
    case 'task_reset':
      return cardRowsBlock({
        keyPrefix,
        label: 'task reset',
        value: `Task ${event.taskId} set to pending`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'implementer_generate_running':
      return runningImplementerRowBlock(keyPrefix, event, ctx);
    case 'implementer_generate_done':
      return implementerDoneRowBlock(keyPrefix, event, ctx, expanded);
    case 'implementer_generate_failed':
      return cardRowsBlock({
        keyPrefix,
        label: 'failed',
        value: event.model === undefined ? undefined : formatModelName(event.model),
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    case 'validate':
      return validateRowBlock(keyPrefix, event, ctx.width);
    case 'validation_baseline':
      return baselineValidationRowBlock(keyPrefix, event, ctx.width);
    case 'escalate':
      return escalateRowBlock(keyPrefix, event, ctx.width);
    case 'artifact_written':
      return artifactWrittenRowBlock(keyPrefix, event, ctx.width);
    case 'git_commit':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'committed',
        value: event.message,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_checkpoint':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'checkpoint',
        value: event.tag,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_branch_created':
      return cardRowsBlock({
        keyPrefix,
        label: 'branch',
        value: event.name,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'message_queued': {
      const header = queuedMessageHeader(event.origin);
      return compositeBlock(keyPrefix, [
        cardRowsBlock({
          keyPrefix: `${keyPrefix}-header-0`,
          label: header.label,
          value: header.value,
          width: ctx.width,
          labelTone: header.tone,
          valueTone: 'textDim',
          markerTone: header.tone,
        }),
        event.preview
          ? wrappedTextBlock({
              keyPrefix: `${keyPrefix}-preview-1`,
              text: event.preview,
              width: ctx.width,
              tone: 'text',
            })
          : null,
      ]);
    }
    case 'message_injected_native':
      return cardRowsBlock({
        keyPrefix,
        label: 'injected',
        value: queueMessageValue('Message delivered to live session', event.preview),
        width: ctx.width,
        labelTone: 'success',
      });
    case 'queue_drained':
      return cardRowsBlock({
        keyPrefix,
        label: 'drained',
        value: `${event.count} queued ${pluralize(event.count, 'message')} folded into next prompt`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'queue_cleared':
      return cardRowsBlock({
        keyPrefix,
        label: 'queue cleared',
        value: `${event.count} pending ${pluralize(event.count, 'message')} removed`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'user_message':
      return promptTextBlock({ keyPrefix, text: event.text, width: ctx.width });
    case 'planner_attachments_dropped':
      return cardRowsBlock({
        keyPrefix,
        label: 'attachments dropped',
        value: `${countNoun(event.count, 'image')} dropped (${event.reason})`,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'warning':
      return calloutRowsBlock({
        keyPrefix,
        label: 'warning',
        value: event.message,
        width: ctx.width,
        severity: 'warning',
      });
    case 'error':
      return calloutRowsBlock({
        keyPrefix,
        label: 'error',
        value: event.message,
        width: ctx.width,
        severity: 'error',
      });
    case 'cost_prediction':
      return rowsBlock(keyPrefix, costPredictionRows(keyPrefix, event, ctx.width));
    case 'budget_warning':
      return calloutRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `80% reached: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        severity: 'warning',
      });
    case 'budget_paused':
      return calloutRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `Paused: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        severity: 'warning',
      });
    case 'budget_exceeded':
      return calloutRowsBlock({
        keyPrefix,
        label: 'budget',
        value: `Exceeded: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`,
        width: ctx.width,
        severity: 'error',
      });
    case 'approval_mode_changed':
      return cardRowsBlock({
        keyPrefix,
        label: 'approval',
        value: event.mode === 'yolo' ? 'tiered approvals disabled' : 'tiered approvals restored',
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'runner_call_activity':
      return runnerActivityBatchRowBlock({
        events: [event],
        batchKey: keyPrefix,
        width: ctx.width,
      });
    case 'turn_interrupted':
      return calloutRowsBlock({
        keyPrefix,
        label: 'interrupted',
        value: 'Turn stopped — type instructions to steer, or press Enter to retry.',
        width: ctx.width,
        severity: 'warning',
      });
    default:
      return assertNever(event);
  }
}

function queueMessageValue(base: string, preview: string | undefined): string {
  return preview ? `${base}: ${preview}` : base;
}

function queuedMessageHeader(origin: EngineEventOf<'message_queued'>['origin']): {
  label: string;
  value: string;
  tone: ConversationRowTone;
} {
  return origin === 'clarification'
    ? { label: 'answered', value: 'recorded — applied at the next planner call', tone: 'success' }
    : { label: 'Queued', value: 'applies at the next planner prompt', tone: 'info' };
}

function recoveryResolvedTone(
  outcome: EngineEventOf<'recovery_resolved'>['outcome'],
): ConversationRowTone {
  switch (outcome) {
    case 'continued':
    case 'retry-current-task':
      return 'success';
    case 'skipped-current-task':
      return 'textDim';
    case 'aborted':
      return 'error';
    default:
      return assertNever(outcome);
  }
}

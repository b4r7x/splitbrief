import { formatScoreSummary } from '../../../../core/formatting.js';
import { formatModelName } from '../../../../core/model-display.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { pluralize, countNoun } from '../../../../utils/pluralize.js';
import { runnerActivityBatchRowBlock } from '../activity-rows.js';
import { borderedCardRowsBlock } from '../bordered-card-block.js';
import { calloutRowsBlock } from '../callout-block.js';
import { formatExternalChangesValue } from '../event-format.js';
import type { ConversationRowBlock, ConversationRowTone, RowBuildContext } from '../types.js';
import {
  cardRowsBlock,
  compositeBlock,
  promptTextBlock,
  rowSeedsBlock,
  wrappedTextBlock,
} from '../row-block-compose.js';
import { artifactWrittenRowBlock } from './artifact-card.js';
import { answeredQuestionsRowBlock } from './answered-questions.js';
import { taskStartedMetadata, taskStartedRowBlock } from '../task-started-row-block.js';
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
import { WORKFLOW_CANCEL_REASON_USER } from '../../../../engine/events/workflow-cancel.js';
import { stripRecoveryResetClause } from '../../recovery-prompt.js';
import { recoveryActionLabel } from '../../recovery-prompt.js';

function sentenceCaseIdentifier(value: string): string {
  const words = value.replace(/[-_]+/gu, ' ').trim();
  return words.length === 0 ? words : `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}

function recoveryOutcomeLabel(value: string): string {
  switch (value) {
    case 'continued':
      return 'Continued';
    case 'retry-current-task':
      return 'Tried again';
    case 'skipped-current-task':
      return 'Skipped current task';
    case 'aborted':
      return 'Ended run';
    default:
      return sentenceCaseIdentifier(value);
  }
}

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
      // Two different endings wore one word. A run the user stopped kept its changes on purpose; a
      // run that fell over did not, and the transcript must not read the same for both.
      return rowSeedsBlock(keyPrefix, [
        {
          key: `${keyPrefix}-title`,
          text: event.reason === WORKFLOW_CANCEL_REASON_USER ? 'Stopped by you' : 'Build failed',
          tone: 'textDim',
          bold: true,
        },
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
        label: 'Recovery',
        // The prompt panel below carries the clock; the card names what happened, once.
        value: stripRecoveryResetClause(event.headline),
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'recovery_action_selected':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'Recovery',
        value: `Selected ${recoveryActionLabel(event.action, { seat: event.seat })} for ${sentenceCaseIdentifier(event.reason)}`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'recovery_action_failed':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'Recovery',
        value: `${recoveryActionLabel(event.action, { seat: event.seat })} blocked: ${event.message}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    case 'recovery_resolved':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'Recovery',
        value: `${recoveryOutcomeLabel(event.outcome)} via ${recoveryActionLabel(event.action, { seat: event.seat })}${event.implementerProfile ? ` · ${event.implementerProfile}` : ''}`,
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
        metadata: taskStartedMetadata(event),
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
        // The build block counts attempts, first try included. A retry index over a retry budget
        // beside it would put two numbers on one screen for one fact.
        text: `retry  attempt ${event.attempt + 1} of ${event.maxRetries + 1}`,
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
      return event.qa !== undefined && event.qa.length > 0
        ? answeredQuestionsRowBlock({ keyPrefix, qa: event.qa, width: ctx.width })
        : promptTextBlock({ keyPrefix, text: event.text, width: ctx.width });
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

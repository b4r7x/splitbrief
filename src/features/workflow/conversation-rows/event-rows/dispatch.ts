import { CREW_SEAT_LABELS, formatSeatCandidateIdentity } from '../../../../core/crew/identity.js';
import { arrowSep, SOFT_SEP } from '../../../../core/separators.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
} from '../../../../utils/display-text.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { pluralize, countNoun } from '../../../../utils/pluralize.js';
import { runnerActivityBatchRowBlock } from '../activity-rows.js';
import { borderedCardRowsBlock } from '../bordered-card-block.js';
import { calloutRowsBlock } from '../callout-block.js';
import { wrapWidthFor } from '../row-markers.js';
import { sanitizeRowDisplayText } from '../row-format/text.js';
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
  fullSuiteRowBlock,
  implementerDoneRowBlock,
  runningImplementerRowBlock,
  validateRowBlock,
} from './execution.js';
import { plannerTextRowBlock } from './planner-text.js';
import { isTranscriptRowlessEvent } from './visibility.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../../../engine/events/workflow-cancel.js';
import { formatResetAt, stripRecoveryResetClause } from '../../../../core/recovery/reset-clock.js';
import { stopPoint } from '../../stop/copy.js';
import { recoveryActionLabel } from '../../../../core/recovery/action-label.js';
import type { RecoveryFold } from '../transcript-walk.js';

const DISCOVERED_VALIDATION_REFUSED = 'discovered_validation_refused';

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
    case 'recovery_action_failed':
      return cardRowsBlock({
        keyPrefix,
        label: 'Recovery',
        value: `${recoveryActionLabel(event.action, { seat: event.seat })} blocked: ${event.message}`,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    // `walkTranscript` folds these into one Recovery row, painted by `recoveryRowBlock`.
    case 'recovery_prompted':
    case 'recovery_action_selected':
    case 'recovery_resolved':
      return null;
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
        label: `Rewind ${glyph('connectorHandoff')} spec`,
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'rewind_to_plan':
      return cardRowsBlock({
        keyPrefix,
        label: `Rewind ${glyph('connectorHandoff')} plan`,
        value: event.comment || undefined,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'drift_report':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'Drift',
        value:
          [
            ...(event.errorCount > 0 ? [countNoun(event.errorCount, 'error')] : []),
            ...(event.warningCount > 0 ? [countNoun(event.warningCount, 'warning')] : []),
          ].join(SOFT_SEP) || 'clean',
        width: ctx.width,
        labelTone: event.passed ? 'success' : 'textDim',
        valueTone: 'textDim',
      });
    case 'task_started':
      return taskStartedRowBlock({
        keyPrefix,
        taskId: event.taskId,
        title: event.title,
        metadata: taskStartedMetadata(event),
        width: ctx.width,
      });
    case 'task_skipped':
      return cardRowsBlock({
        keyPrefix,
        label: 'Skipped',
        value: `${event.taskId} ${event.title}: ${event.reason}`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'task_touched_not_suggested':
      return wrappedTextBlock({
        keyPrefix,
        text: `${event.taskId} also changed ${event.files.join(', ')}`,
        width: ctx.width,
        tone: 'textDim',
      });
    case 'task_full_fail':
      return cardRowsBlock({
        keyPrefix,
        label: 'Task failed',
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
        text: `Retry  attempt ${event.lineageAttempt ?? event.attempt + 1} of ${event.attemptAllowance ?? event.maxRetries + 1}`,
        width: ctx.width,
        tone: 'textDim',
      });
    case 'seat_switched':
      return wrappedTextBlock({
        keyPrefix,
        text: `${CREW_SEAT_LABELS[event.seat]}${arrowSep()}${formatSeatCandidateIdentity(event.to)}${SOFT_SEP}${seatSwitchCauseWords(event.cause)}`,
        width: ctx.width,
        tone: 'textDim',
      });
    case 'task_reset':
      return cardRowsBlock({
        keyPrefix,
        label: 'Task reset',
        value: `${event.taskId} back to pending`,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'consult_answered':
      return wrappedTextBlock({
        keyPrefix,
        text: consultAnsweredText(event),
        width: ctx.width,
        tone: 'textDim',
      });
    case 'implementer_generate_running':
      return runningImplementerRowBlock(keyPrefix, event, ctx);
    case 'implementer_generate_done':
      return implementerDoneRowBlock(keyPrefix, event, ctx, expanded);
    case 'implementer_generate_failed': {
      const label = `${CREW_SEAT_LABELS.build} failed`;
      const { value } = implementerFailureCard(event, ctx.width, expanded);
      return cardRowsBlock({
        keyPrefix,
        label,
        value,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
      });
    }
    case 'validate':
      return validateRowBlock(keyPrefix, event, ctx.width);
    case 'validation_baseline':
      return baselineValidationRowBlock(keyPrefix, event, ctx.width);
    case 'full_suite':
      return fullSuiteRowBlock(keyPrefix, event, ctx.width);
    case 'escalate':
      return escalateRowBlock(keyPrefix, event, ctx.width);
    case 'artifact_written':
      return artifactWrittenRowBlock(keyPrefix, event, ctx.width);
    case 'git_commit':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'Committed',
        value: event.message,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_checkpoint':
      return borderedCardRowsBlock({
        keyPrefix,
        label: 'Checkpoint',
        value: event.tag,
        width: ctx.width,
        labelTone: 'success',
      });
    case 'git_branch_created':
      return cardRowsBlock({
        keyPrefix,
        label: 'Branch',
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
        label: 'Injected',
        value: queueMessageValue('Message delivered to live session', event.preview),
        width: ctx.width,
        labelTone: 'success',
      });
    case 'queue_drained':
      return cardRowsBlock({
        keyPrefix,
        label: 'Drained',
        value: `${event.count} queued ${pluralize(event.count, 'message')} folded into next prompt`,
        width: ctx.width,
        labelTone: 'textDim',
      });
    case 'queue_cleared':
      return cardRowsBlock({
        keyPrefix,
        label: 'Queue cleared',
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
        label: 'Attachments dropped',
        value: `${countNoun(event.count, 'image')} dropped (${event.reason})`,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'warning':
      // A planner command the stage did not take is a note on the plan, not a fault to act on.
      if (event.code === DISCOVERED_VALIDATION_REFUSED) {
        return cardRowsBlock({
          keyPrefix,
          label: 'Validation',
          value: event.message,
          width: ctx.width,
          labelTone: 'textDim',
          valueTone: 'textDim',
        });
      }
      return calloutRowsBlock({
        keyPrefix,
        label: 'Warning',
        value: event.message,
        width: ctx.width,
        severity: 'warning',
      });
    case 'error':
      return calloutRowsBlock({
        keyPrefix,
        label: 'Error',
        // The words are stored and name no clock; the reset is spelled now, as the header spells it.
        meta: formatResetAt(event.resetAt),
        value: event.message,
        width: ctx.width,
        severity: 'error',
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
        label: 'Stopped',
        // The row states where the run stopped; the byline under the composer says what continues it.
        value: event.step === undefined ? 'mid-turn' : stopPoint(event.step, event.at),
        width: ctx.width,
        severity: 'warning',
      });
    default:
      return assertNever(event);
  }
}

function implementerFailureCause(
  event: Extract<EngineEvent, { type: 'implementer_generate_failed' }>,
): string | undefined {
  const cause = event.error
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return cause === undefined ? undefined : sanitizeRowDisplayText(cause);
}

export function implementerFailureCard(
  event: Extract<EngineEvent, { type: 'implementer_generate_failed' }>,
  width: number,
  expanded: boolean,
): { value: string | undefined; expandable: boolean } {
  const cause = implementerFailureCause(event);
  const valueWidth =
    wrapWidthFor('card', width) - getTerminalCellWidth(`${CREW_SEAT_LABELS.build} failed  `);
  if (cause === undefined || valueWidth <= 0) return { value: undefined, expandable: false };
  const cut = getTerminalCellWidth(cause) > valueWidth;
  return {
    value: cut && expanded ? cause : truncateTerminalDisplayText(cause, valueWidth),
    expandable: cut,
  };
}

function queueMessageValue(base: string, preview: string | undefined): string {
  return preview ? `${base}: ${preview}` : base;
}

function seatSwitchCauseWords(cause: EngineEventOf<'seat_switched'>['cause']): string {
  switch (cause) {
    case 'runner-usage-limit':
      return 'usage limit';
    case 'runner-unauthenticated':
      return 'signed out';
    default:
      return cause.replaceAll('-', ' ');
  }
}

function queuedMessageHeader(origin: EngineEventOf<'message_queued'>['origin']): {
  label: string;
  value: string;
  tone: ConversationRowTone;
} {
  return origin === 'clarification'
    ? { label: 'Answered', value: 'recorded — applied at the next planner call', tone: 'success' }
    : { label: 'Queued', value: 'applies at the next planner prompt', tone: 'info' };
}

function consultAnsweredText(event: EngineEventOf<'consult_answered'>): string {
  if (event.reason === 'deviation') {
    if (event.action === 'confirm') {
      return `${CREW_SEAT_LABELS.plan} confirmed ${countNoun(event.decisionCount ?? 0, 'decision')} for ${event.taskId}`;
    }
    if (event.action === 'ask-user') {
      return `${CREW_SEAT_LABELS.plan} asks you about the decisions ${event.taskId} reported`;
    }
  }
  return `${CREW_SEAT_LABELS.plan}${arrowSep()}${event.taskId}: ${consultAnsweredAction(event)}`;
}

function consultAnsweredAction(event: EngineEventOf<'consult_answered'>): string {
  switch (event.action) {
    case 'guidance':
      return `guidance${SOFT_SEP}${event.diagnosis}`;
    case 'rewrite-task':
      return event.revision === undefined
        ? `rewrote ${event.taskId}`
        : `rewrote ${event.taskId} (rev ${event.revision})`;
    case 'split-task': {
      const ids = event.newTaskIds;
      const summary = ids === null || ids.length === 0 ? 'split' : `split into ${ids.join(', ')}`;
      return `${summary}${SOFT_SEP}${event.diagnosis}`;
    }
    case 'verify':
      return event.checkIds === undefined || event.checkIds.length === 0
        ? 'verify'
        : `verify ${event.checkIds.join(', ')}`;
    case 'ask-user':
      return 'asks you';
    case 'confirm':
      return `confirmed the deviation${SOFT_SEP}${event.diagnosis}`;
    default:
      return assertNever(event.action);
  }
}

export function recoveryRowBlock(
  keyPrefix: string,
  recovery: RecoveryFold,
  width: number,
): ConversationRowBlock | null {
  const { prompted, reset, resolved } = recovery;
  const chosen = recovery.selected ?? resolved;
  const outcome = [
    reset === undefined ? null : `${reset.taskId} back to pending`,
    resolved === undefined ? null : recoveryOutcomeWords(resolved.outcome),
  ].filter((part): part is string => part !== null);
  const action =
    chosen === undefined ? null : recoveryActionLabel(chosen.action, { seat: chosen.seat });
  const done =
    action === null || outcome.length === 0
      ? action
      : `${action}${arrowSep()}${outcome.join(', ')}`;
  // The prompt panel carries the clock; the row names what happened, once.
  const halt = prompted === undefined ? null : stripRecoveryResetClause(prompted.headline);
  return cardRowsBlock({
    keyPrefix,
    label: 'Recovery',
    value: [halt, done].filter((part): part is string => part !== null).join(SOFT_SEP),
    width,
    labelTone: resolved === undefined ? 'textDim' : recoveryResolvedTone(resolved.outcome),
    valueTone: 'textDim',
  });
}

function recoveryOutcomeWords(outcome: EngineEventOf<'recovery_resolved'>['outcome']): string {
  switch (outcome) {
    case 'continued':
      return 'continued';
    case 'retry-current-task':
      return 'retried';
    case 'skipped-current-task':
      return 'skipped';
    case 'aborted':
      return 'run ended';
    default:
      return assertNever(outcome);
  }
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

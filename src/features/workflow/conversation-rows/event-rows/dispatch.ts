import { INLINE_LABEL_GAP } from '../row-format/label-card.js';
import { CREW_SEAT_LABELS, formatSeatCandidateIdentity } from '../../../../core/crew/identity.js';
import type { DriftFinding } from '../../../../core/schemas/drift.js';
import { arrowSep, SOFT_SEP } from '../../../../core/separators.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
} from '../../../../utils/display-text.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { countNoun } from '../../../../utils/pluralize.js';
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
import { attachedInputsRowBlock } from './attached-inputs.js';
import {
  taskStartedMetadata,
  taskStartedCrewRowBlock,
  taskStartedRowBlock,
} from '../task-started-row-block.js';
import { isRunnerCallTranscriptRowSuppressed } from '../runner-call-classification.js';
import {
  escalateRowBlock,
  fullSuiteRowBlock,
  implementerDoneRowBlock,
  reviewChecksRowBlock,
  runningImplementerRowBlock,
  validateRowBlock,
} from './execution.js';
import { plannerTextRowBlock } from './planner-text.js';
import { isTranscriptRowlessEvent } from './visibility.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../../../engine/events/workflow-cancel.js';
import { formatResetAt, stripRecoveryResetClause } from '../../../../core/recovery/reset-clock.js';
import { stopPoint } from '../../stop/copy.js';
import { recoveryActionLabel } from '../../../../core/recovery/action-label.js';
import { formatSeatSwitchCause } from '../../../../core/recovery/headline.js';
import type { RecoveryFold, SettledTranscriptSection } from '../transcript-walk.js';
import { phaseStage } from '../../../../core/rail-stages.js';
import { queueCopy } from '../../queue-copy.js';

const DISCOVERED_VALIDATION_REFUSED = 'discovered_validation_refused';
export const COLLAPSED_DRIFT_FINDING_LIMIT = 3;

export function eventRowBlock(options: {
  event: EngineEvent;
  globalIndex: number;
  ctx: RowBuildContext;
  expanded: boolean;
  dedupTitle?: string | undefined;
  settledSection?: SettledTranscriptSection | undefined;
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
    case 'drift_report': {
      const findings = orderedDriftFindings(event);
      const visible = expanded ? findings : findings.slice(0, COLLAPSED_DRIFT_FINDING_LIMIT);
      const remaining = findings.length - visible.length;
      return compositeBlock(keyPrefix, [
        wrappedTextBlock({
          keyPrefix,
          text: driftHeadline(event),
          width: ctx.width,
          tone: driftTone(event),
          continuationIndent: 2,
        }),
        ...visible.map((finding, index) =>
          wrappedTextBlock({
            keyPrefix: `${keyPrefix}-finding-${index}`,
            text: `${finding.severity}${SOFT_SEP}${finding.message}`,
            width: ctx.width,
            tone: 'textDim',
            indent: 2,
            continuationIndent: 2,
          }),
        ),
        remaining > 0
          ? wrappedTextBlock({
              keyPrefix: `${keyPrefix}-more`,
              text: `+${countNoun(remaining, 'more finding')}${SOFT_SEP}click`,
              width: ctx.width,
              tone: 'textDim',
              indent: 2,
              continuationIndent: 2,
            })
          : null,
      ]);
    }
    case 'task_started':
      if (options.settledSection !== undefined) {
        return taskStartedCrewRowBlock({
          keyPrefix,
          event,
          width: ctx.width,
        });
      }
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
        text: `${CREW_SEAT_LABELS[event.seat]}${arrowSep()}${formatSeatCandidateIdentity(event.to)}${SOFT_SEP}${event.auto ? `automatic fallback${SOFT_SEP}` : ''}${formatSeatSwitchCause(event)}`,
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
    case 'review_checks':
      return reviewChecksRowBlock(keyPrefix, event, ctx.width);
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
    case 'message_queued':
    case 'message_injected_native': {
      const seat =
        event.type === 'message_injected_native' ? 'plan' : (event.seat ?? phaseStage(event.phase));
      const copy = queueCopy({
        seat,
        taskId: event.type === 'message_queued' ? event.taskId : undefined,
        steerable: event.type === 'message_queued' && event.steerable,
      });
      const header =
        event.type === 'message_injected_native'
          ? { ...copy.delivered, tone: 'success' as const }
          : event.origin === 'clarification'
            ? {
                label: 'Answered',
                value: 'recorded — applied at the next planner call',
                tone: 'success' as const,
              }
            : { ...copy.queued, tone: 'info' as const };
      return compositeBlock(keyPrefix, [
        cardRowsBlock({
          keyPrefix: `${keyPrefix}-header-0`,
          label: header.label,
          labelGap: header.label === 'Answered' ? undefined : INLINE_LABEL_GAP,
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
    case 'queue_drained': {
      const seat = event.seat ?? phaseStage(event.phase);
      const copy = queueCopy({ seat, taskId: event.taskId, count: event.count, via: event.via });
      return cardRowsBlock({
        keyPrefix,
        label: copy.delivered.label,
        labelGap: INLINE_LABEL_GAP,
        value: copy.delivered.value,
        width: ctx.width,
        labelTone: 'success',
        valueTone: 'textDim',
        markerTone: 'success',
      });
    }
    case 'queue_cleared': {
      const copy = queueCopy({ seat: null, count: event.count });
      return cardRowsBlock({
        keyPrefix,
        label: copy.cleared.label,
        value: copy.cleared.value,
        width: ctx.width,
        labelTone: 'textDim',
      });
    }
    case 'user_message': {
      const body =
        event.qa !== undefined && event.qa.length > 0
          ? answeredQuestionsRowBlock({ keyPrefix, qa: event.qa, width: ctx.width })
          : promptTextBlock({ keyPrefix, text: event.text, width: ctx.width });
      if (event.attachedInputs === undefined || event.attachedInputs.length === 0) return body;
      return compositeBlock(keyPrefix, [
        body,
        attachedInputsRowBlock({
          keyPrefix: `${keyPrefix}-attached-inputs`,
          attachedInputs: event.attachedInputs,
          width: ctx.width,
        }),
      ]);
    }
    case 'build_images_as_paths': {
      const copy = queueCopy({ seat: 'build', taskId: event.taskId, count: event.count });
      return cardRowsBlock({
        keyPrefix,
        label: copy.imagesAsPaths.label,
        labelGap: INLINE_LABEL_GAP,
        value: copy.imagesAsPaths.value,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    }
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
        label: `Stopped ${event.step === undefined ? 'mid-turn' : stopPoint(event.step, event.at)}`,
        value: undefined,
        width: ctx.width,
        severity: 'warning',
      });
    default:
      return assertNever(event);
  }
}

function driftHeadline(event: EngineEventOf<'drift_report'>): string {
  const parts = ['Drift'];
  if (!event.passed) parts.push('failed');
  if (event.errorCount > 0) parts.push(countNoun(event.errorCount, 'error'));
  if (event.warningCount > 0) parts.push(countNoun(event.warningCount, 'warning'));
  if (parts.length === 1) parts.push('clean');
  return parts.join(SOFT_SEP);
}

function driftTone(event: EngineEventOf<'drift_report'>): ConversationRowTone {
  if (!event.passed) return 'error';
  return event.warningCount > 0 ? 'warning' : 'textDim';
}

export function orderedDriftFindings(event: EngineEventOf<'drift_report'>): DriftFinding[] {
  const findings = event.findings ?? [];
  return [
    ...findings.filter((finding) => finding.severity === 'error'),
    ...findings.filter((finding) => finding.severity === 'warning'),
  ];
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

function consultAnsweredText(event: EngineEventOf<'consult_answered'>): string {
  if (event.reason === 'deviation') {
    if (event.action === 'confirm') {
      return `${CREW_SEAT_LABELS.plan} confirmed ${countNoun(event.decisionCount ?? 0, 'decision')} for ${event.taskId}`;
    }
    if (event.action === 'ask-user') {
      return `${CREW_SEAT_LABELS.plan} asks you about the decisions ${event.taskId} reported`;
    }
  }
  return `${CREW_SEAT_LABELS[event.seat ?? 'plan']}${arrowSep()}${event.taskId}: ${consultAnsweredAction(event)}`;
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

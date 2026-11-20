import { INLINE_LABEL_GAP } from '../row-format/label-card.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { setAsideLabel } from '../../../../core/review/verdict.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { runnerActivityBatchRowBlock } from '../activity/rows.js';
import { borderedCardRowsBlock } from '../blocks/bordered-card.js';
import { calloutRowsBlock, checkoutWarningBlock } from '../blocks/callout.js';
import { segmentedRow } from '../row-format/rows.js';
import type { ConversationRowBlock, ConversationRowSegment, RowBuildContext } from '../types.js';
import {
  cardRowsBlock,
  compositeBlock,
  rowsBlock,
  sectionSpacerBlock,
  wrappedSegmentsBlock,
} from '../blocks/compose.js';
import { promptTextBlock, wrappedTextBlock } from '../blocks/wrapped-text.js';
import { planCompiledRowBlock } from './plan-block.js';
import { artifactWrittenRowBlock } from './artifact-card.js';
import { answeredQuestionsRowBlock, repliedQuestionsRowBlock } from './answered-questions.js';
import { attachedInputsRowBlock } from './attached-inputs.js';
import {
  taskStartedMetadata,
  taskStartedCrewRowBlock,
  taskStartedRowBlock,
} from '../blocks/task-started.js';
import { isRunnerCallTranscriptRowSuppressed } from '../runner-call-classification.js';
import {
  escalateRowBlock,
  fullSuiteRowBlock,
  implementerDoneRowBlock,
  implementerFailedRowBlock,
  reviewChecksRowBlock,
  reviewNoneRowBlock,
  runningImplementerRowBlock,
  validateRowBlock,
} from './execution.js';
import { plannerTextRowBlock } from './planner-text.js';
import { isTranscriptRowlessEvent } from './visibility.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../../../engine/events/workflow-cancel.js';
import { formatResetAt } from '../../../../core/recovery/reset-clock.js';
import { stopPoint } from '../../display/step-words.js';
import type { SettledTranscriptSection } from '../transcript-walk/types.js';
import { queueCopy } from '../../queue-copy.js';
import { formatRejectRunMessage } from '../../../../core/runtime/commands/messages.js';
import { recoveryActionFailedRowBlock } from './recovery.js';
import { queueRowBlock } from './queue.js';
import { seatSwitchedRowBlock } from './seat-switched.js';
import { consultAnsweredSegments } from './consult.js';

const DISCOVERED_VALIDATION_REFUSED = 'discovered_validation_refused';

export function eventRowBlock(options: {
  event: EngineEvent;
  globalIndex: number;
  ctx: RowBuildContext;
  expanded: boolean;
  dedupTitle?: string | undefined;
  settledSection?: SettledTranscriptSection | undefined;
  causeInRecovery?: boolean | undefined;
}): ConversationRowBlock | null {
  const { event, globalIndex, ctx, expanded } = options;
  const keyPrefix = `event-${globalIndex}-${event.type}`;

  if (isRunnerCallTranscriptRowSuppressed(event)) return null;
  if (isTranscriptRowlessEvent(event)) return null;

  switch (event.type) {
    case 'workflow_resumed':
      return wrappedTextBlock({
        keyPrefix,
        text: 'Run continued',
        width: ctx.width,
        tone: 'textDim',
      });
    case 'workflow_cancelled': {
      const segments: ConversationRowSegment[] =
        event.reason === WORKFLOW_CANCEL_REASON_USER
          ? [{ text: 'Stopped by you', tone: stateTone('attention') }]
          : [
              { text: 'Build', tone: CREW_SEAT_ROLES.build },
              { text: ' ', tone: 'textDim' },
              { text: 'failed', tone: stateTone('failed') },
            ];
      return rowsBlock(keyPrefix, [
        segmentedRow(
          `${keyPrefix}-title`,
          segments.map((segment) => ({ ...segment, bold: true })),
          'message',
        ),
      ]);
    }
    case 'recovery_action_failed':
      return recoveryActionFailedRowBlock(keyPrefix, event, ctx.width);
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
    case 'run_rejected':
      return cardRowsBlock({
        keyPrefix,
        label: 'Rejected',
        value: formatRejectRunMessage(event),
        width: ctx.width,
        labelTone: stateTone('attention'),
        valueTone: 'textDim',
        markerTone: stateTone('attention'),
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
        label: 'Brief failed',
        value: event.taskId,
        width: ctx.width,
        labelTone: 'error',
        valueTone: 'textDim',
        kind: 'summary',
      });
    case 'task_retry':
      return wrappedTextBlock({
        keyPrefix,
        // The lineage's attempt, first try included, as the halt's Attempts: N counts it.
        text: `Retry  attempt ${event.lineageAttempt ?? event.attempt + 1}`,
        width: ctx.width,
        tone: 'textDim',
      });
    case 'seat_switched':
      return seatSwitchedRowBlock(keyPrefix, event, ctx.width, options.causeInRecovery);
    case 'review_completed': {
      const cards: ConversationRowBlock[] = [
        ...(event.blockingFindings ?? []).map((finding, index) =>
          cardRowsBlock({
            keyPrefix: `${keyPrefix}-finding-${index}`,
            label: `Blocking ${finding.id}`,
            value: finding.text,
            hangValue: true,
            width: ctx.width,
            labelTone: stateTone('failed'),
            valueTone: 'textDim',
            markerTone: stateTone('failed'),
          }),
        ),
        ...(event.setAside ?? []).map((entry, index) =>
          cardRowsBlock({
            keyPrefix: `${keyPrefix}-set-aside-${index}`,
            label: setAsideLabel(entry.id),
            value: entry.reason,
            hangValue: true,
            width: ctx.width,
            labelTone: 'text',
            valueTone: 'textDim',
          }),
        ),
      ].filter((block): block is ConversationRowBlock => block !== null);
      const blocks: ConversationRowBlock[] = [];
      for (const card of cards) {
        if (blocks.length > 0) blocks.push(sectionSpacerBlock(card.key));
        blocks.push(card);
      }
      return compositeBlock(keyPrefix, blocks);
    }
    case 'task_reset':
      return cardRowsBlock({
        keyPrefix,
        label: 'Brief reset',
        value: `${event.taskId} back to pending`,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'textDim',
      });
    case 'consult_answered':
      return wrappedSegmentsBlock({
        keyPrefix,
        segments: consultAnsweredSegments(event),
        width: ctx.width,
      });
    case 'implementer_generate_running':
      return runningImplementerRowBlock(keyPrefix, event, ctx);
    case 'implementer_generate_done':
      return implementerDoneRowBlock(keyPrefix, event, ctx, expanded);
    case 'implementer_generate_failed':
      return implementerFailedRowBlock(keyPrefix, event, ctx.width, expanded);
    case 'validate':
      return validateRowBlock(keyPrefix, event, ctx.width);
    case 'review_checks':
      return reviewChecksRowBlock(keyPrefix, event, ctx.width);
    case 'workflow_complete':
      return reviewNoneRowBlock(keyPrefix, ctx.width);
    case 'full_suite':
      return fullSuiteRowBlock(keyPrefix, event, ctx.width);
    case 'escalate':
      return escalateRowBlock(keyPrefix, event, ctx.width);
    case 'plan_compiled':
      return planCompiledRowBlock(keyPrefix, event, ctx.width);
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
    case 'message_injected_native':
    case 'queue_drained':
    case 'queue_cleared':
      return queueRowBlock(keyPrefix, event, ctx.width, ctx);
    case 'user_message': {
      const body =
        event.qa !== undefined && event.qa.length > 0
          ? answeredQuestionsRowBlock({ keyPrefix, qa: event.qa, width: ctx.width })
          : event.questions !== undefined
            ? repliedQuestionsRowBlock({
                keyPrefix,
                questions: event.questions,
                reply: event.text,
                width: ctx.width,
              })
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
    case 'info':
      return cardRowsBlock({
        keyPrefix,
        label: SPLITBRIEF_IDENTITY.displayName,
        value: event.message,
        width: ctx.width,
        labelTone: 'textDim',
        valueTone: 'text',
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
      if (event.checkout !== undefined)
        return checkoutWarningBlock(event.checkout, globalIndex, ctx.width, expanded);
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

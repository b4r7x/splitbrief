import { INLINE_LABEL_GAP } from '../row-format/label-card.js';
import { CREW_SEAT_LABELS } from '../../../../core/crew/identity.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';
import { formatRecordedSeatChangeIdentities } from '../../display/recorded-seat-identity.js';
import { COLLAPSE_HINT } from '../implementer-diff-card-block.js';
import type { DriftFinding } from '../../../../core/schemas/drift.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
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
import { segmentedRow } from '../row-format/rows.js';
import type {
  ConversationRowBlock,
  ConversationRowSegment,
  ConversationRowTone,
  RowBuildContext,
} from '../types.js';
import {
  cardRowsBlock,
  compositeBlock,
  promptTextBlock,
  rowsBlock,
  wrappedSegmentsBlock,
  wholeSegmentsBlock,
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
import { recoveryActionParts } from '../../../../core/recovery/action-label.js';
import { formatSeatSwitchCause } from '../../../../core/recovery/headline.js';
import type { RecoveryFold, SettledTranscriptSection } from '../transcript-walk.js';
import { phaseStage } from '../../../../core/rail-stages.js';
import { queueCopy } from '../../queue-copy.js';
import { formatRejectRunMessage } from '../../../../core/runtime/commands/messages.js';

const DISCOVERED_VALIDATION_REFUSED = 'discovered_validation_refused';
export const COLLAPSED_DRIFT_FINDING_LIMIT = 3;

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
      return recoveryCardBlock(
        keyPrefix,
        [
          ...recoveryActionSegments(event),
          { text: ' ', tone: 'textDim' },
          { text: 'blocked', tone: stateTone('failed') },
          { text: ': ', tone: 'textDim' },
          { text: event.message, tone: 'textDim' },
        ],
        ctx.width,
        stateTone('failed'),
      );
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
        wrappedSegmentsBlock({
          keyPrefix,
          segments: driftHeadlineSegments(event),
          width: ctx.width,
          continuationIndent: 2,
        }),
        ...visible.map((finding, index) =>
          wrappedSegmentsBlock({
            keyPrefix: `${keyPrefix}-finding-${index}`,
            segments: [
              {
                text: finding.severity,
                tone: stateTone(finding.severity === 'error' ? 'failed' : 'attention'),
              },
              { text: SOFT_SEP, tone: 'textDim' },
              { text: finding.message, tone: 'textDim' },
            ],
            width: ctx.width,
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
    case 'seat_switched': {
      const identities = formatRecordedSeatChangeIdentities(
        event.from,
        event.to,
        CREW_SEAT_ROLES[event.seat],
      );
      const parts = (
        identity: string,
        prefix: ConversationRowSegment[],
      ): ConversationRowSegment[][] => {
        const segments: ConversationRowSegment[] = identity
          .split(SOFT_SEP)
          .flatMap((text, index) => [
            ...(index === 0
              ? []
              : [{ text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment]),
            { text, tone: CREW_SEAT_ROLES[event.seat] },
          ]);
        const budget = wrapWidthFor('message', ctx.width);
        if (getTerminalCellWidth(identity) <= budget) {
          const prefixWidth = prefix.reduce(
            (total, segment) => total + getTerminalCellWidth(segment.text),
            0,
          );
          return prefixWidth + getTerminalCellWidth(identity) <= budget
            ? [[...prefix, ...segments]]
            : [prefix, segments];
        }
        return identity
          .split(SOFT_SEP)
          .map((text, index) => [
            ...(index === 0
              ? prefix
              : [{ text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment]),
            { text, tone: CREW_SEAT_ROLES[event.seat] },
          ]);
      };
      return wholeSegmentsBlock(
        keyPrefix,
        [
          ...parts(identities.from, [
            { text: CREW_SEAT_LABELS[event.seat], tone: CREW_SEAT_ROLES[event.seat] },
            { text: '  ', tone: 'textDim' },
          ]),
          ...parts(identities.to, [{ text: arrowSep(), tone: 'textDim' }]),
          ...(event.auto
            ? [
                [
                  { text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment,
                  { text: 'automatic fallback', tone: 'textDim' } satisfies ConversationRowSegment,
                ],
              ]
            : []),
          ...(options.causeInRecovery
            ? []
            : [
                [
                  { text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment,
                  {
                    text: formatSeatSwitchCause(event),
                    tone: 'textDim',
                  } satisfies ConversationRowSegment,
                ],
              ]),
        ],
        ctx.width,
        'message',
      );
    }
    case 'review_completed':
      return compositeBlock(
        keyPrefix,
        (event.blockingFindings ?? []).map((finding, index) =>
          cardRowsBlock({
            keyPrefix: `${keyPrefix}-finding-${index}`,
            label: `Blocking ${finding.id}`,
            value: finding.text,
            width: ctx.width,
            labelTone: stateTone('failed'),
            valueTone: 'textDim',
            markerTone: stateTone('failed'),
          }),
        ),
      );
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
      return wrappedSegmentsBlock({
        keyPrefix,
        segments: consultAnsweredSegments(event),
        width: ctx.width,
      });
    case 'implementer_generate_running':
      return runningImplementerRowBlock(keyPrefix, event, ctx);
    case 'implementer_generate_done':
      return implementerDoneRowBlock(keyPrefix, event, ctx, expanded);
    case 'implementer_generate_failed': {
      const { value } = implementerFailureCard(event, ctx.width, expanded);
      return wrappedSegmentsBlock({
        keyPrefix,
        segments: [
          { text: CREW_SEAT_LABELS.build, tone: CREW_SEAT_ROLES.build },
          { text: ' ', tone: 'textDim' },
          { text: 'failed', tone: stateTone('failed') },
          ...(value ? [{ text: `  ${value}`, tone: 'textDim' as const }] : []),
        ],
        width: ctx.width,
        kind: 'card',
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
        checking: event.phase === 'validating-task',
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

function driftHeadlineSegments(event: EngineEventOf<'drift_report'>): ConversationRowSegment[] {
  const parts: ConversationRowSegment[] = [{ text: 'Drift', tone: 'text' }];
  if (!event.passed) parts.push({ text: 'failed', tone: stateTone('failed') });
  if (event.errorCount > 0)
    parts.push({ text: countNoun(event.errorCount, 'error'), tone: stateTone('failed') });
  if (event.warningCount > 0)
    parts.push({ text: countNoun(event.warningCount, 'warning'), tone: stateTone('attention') });
  if (parts.length === 1) parts.push({ text: 'clean', tone: stateTone('passed') });
  return parts.flatMap((part, index) =>
    index === 0 ? [part] : [{ text: SOFT_SEP, tone: 'textDim' }, part],
  );
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

function consultAnsweredSegments(
  event: EngineEventOf<'consult_answered'>,
): ConversationRowSegment[] {
  const seat =
    event.reason === 'deviation' && (event.action === 'confirm' || event.action === 'ask-user')
      ? 'plan'
      : (event.seat ?? 'plan');
  const label = { text: CREW_SEAT_LABELS[seat], tone: CREW_SEAT_ROLES[seat] };
  if (event.reason === 'deviation') {
    if (event.action === 'confirm') {
      const confirmed = event.decisionCount ?? 0;
      const rejected = event.rejectedCount ?? 0;
      const decided =
        rejected === 0
          ? `confirmed ${countNoun(confirmed, 'decision')}`
          : confirmed === 0
            ? `rejected ${countNoun(rejected, 'decision')}`
            : `confirmed ${countNoun(confirmed, 'decision')}, rejected ${rejected}`;
      return [
        label,
        { text: ` ${decided} for ${event.taskId}`, tone: 'textDim' },
        { text: SOFT_SEP, tone: 'textDim' },
        { text: event.diagnosis, tone: 'textDim' },
      ];
    }
    if (event.action === 'ask-user') {
      return [
        label,
        { text: ` asks you about the decisions ${event.taskId} reported`, tone: 'textDim' },
      ];
    }
  }
  return [
    label,
    { text: `${arrowSep()}${event.taskId}: `, tone: 'textDim' },
    ...consultAnsweredAction(event),
  ];
}

function consultAnsweredAction(event: EngineEventOf<'consult_answered'>): ConversationRowSegment[] {
  const detail = (text: string): ConversationRowSegment[] => [
    { text, tone: 'textDim' },
    { text: SOFT_SEP, tone: 'textDim' },
    { text: event.diagnosis, tone: 'textDim' },
  ];
  switch (event.action) {
    case 'guidance':
      return detail('guidance');
    case 'rewrite-task':
      return [
        {
          text:
            event.revision === undefined
              ? `rewrote ${event.taskId}`
              : `rewrote ${event.taskId} (rev ${event.revision})`,
          tone: 'textDim',
        },
      ];
    case 'split-task': {
      const ids = event.newTaskIds;
      const summary = ids === null || ids.length === 0 ? 'split' : `split into ${ids.join(', ')}`;
      return detail(summary);
    }
    case 'verify':
      return [
        {
          text:
            event.checkIds === undefined || event.checkIds.length === 0
              ? 'verify'
              : `verify ${event.checkIds.join(', ')}`,
          tone: 'textDim',
        },
      ];
    case 'ask-user':
      return [{ text: 'asks you', tone: 'textDim' }];
    case 'confirm':
      return detail('confirmed the deviation');
    default:
      return assertNever(event.action);
  }
}

export function recoveryRowBlock(
  keyPrefix: string,
  recovery: RecoveryFold,
  width: number,
  expanded = false,
): ConversationRowBlock | null {
  if (recovery.automaticSwitch !== undefined) {
    const { diagnostics } = recovery;
    return compositeBlock(keyPrefix, [
      wholeSegmentsBlock(
        keyPrefix,
        [
          [
            { text: 'Recovery  ', tone: stateTone('passed') },
            ...recoveryHeadlineSegments(recovery.prompted),
          ],
          [
            { text: `${arrowSep()}continued on fallback`, tone: 'textDim' },
            ...(diagnostics.length === 0
              ? []
              : [
                  {
                    text: expanded ? '' : '  ctrl+d',
                    tone: 'textDim',
                  } satisfies ConversationRowSegment,
                ]),
          ],
        ],
        width,
        'card',
      ),
      expanded
        ? wrappedTextBlock({
            keyPrefix: `${keyPrefix}-details`,
            text: [...diagnostics, COLLAPSE_HINT].join('\n'),
            width,
            tone: 'textDim',
            kind: 'card',
            indent: 2,
          })
        : null,
    ]);
  }
  const { prompted, reset, resolved } = recovery;
  const chosen = recovery.selected ?? resolved;
  const outcome = [
    reset === undefined ? null : `${reset.taskId} back to pending`,
    resolved === undefined ? null : recoveryOutcomeWords(resolved.outcome, recovery),
  ].filter((part): part is string => part !== null);
  const done = chosen === undefined ? [] : recoveryActionSegments(chosen, recovery.seatSwitch);
  if (done.length > 0 && outcome.length > 0) {
    done.push({ text: `${arrowSep()}${outcome.join(', ')}`, tone: 'textDim' });
  }
  // The prompt panel carries the clock; the row names what happened, once.
  const halt =
    prompted === undefined || recovery.haltAlreadyShown ? [] : recoveryHeadlineSegments(prompted);
  return recoveryCardBlock(
    keyPrefix,
    [
      ...halt,
      ...(halt.length > 0 && done.length > 0 ? [{ text: SOFT_SEP, tone: 'textDim' as const }] : []),
      ...done,
    ],
    width,
    resolved === undefined ? stateTone('attention') : recoveryResolvedTone(resolved.outcome),
  );
}

function recoveryCardBlock(
  keyPrefix: string,
  value: ConversationRowSegment[],
  width: number,
  tone: ConversationRowTone,
): ConversationRowBlock | null {
  return wrappedSegmentsBlock({
    keyPrefix,
    segments: [{ text: value.length === 0 ? 'Recovery' : 'Recovery  ', tone }, ...value],
    width,
    kind: 'card',
  });
}

function recoveryActionSegments(
  event: Pick<EngineEventOf<'recovery_action_selected'>, 'action' | 'reason' | 'seat'>,
  switched?: EngineEventOf<'seat_switched'>,
): ConversationRowSegment[] {
  const modelChanged =
    event.action === 'switch-seat' &&
    switched !== undefined &&
    typeof switched.from !== 'string' &&
    typeof switched.to !== 'string' &&
    switched.from.tool === switched.to.tool &&
    switched.from.model !== switched.to.model;
  return recoveryActionParts(event.action, { reason: event.reason, seat: event.seat }).map(
    (part) => ({
      text: modelChanged ? part.text.replace('tool', 'model') : part.text,
      tone: part.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[part.seat],
    }),
  );
}

function recoveryHeadlineSegments(
  event: EngineEventOf<'recovery_prompted'>,
): ConversationRowSegment[] {
  return (event.headlineSpans ?? [{ text: event.headline }]).map((part) => ({
    text: stripRecoveryResetClause(part.text),
    tone: part.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[part.seat],
  }));
}

function recoveryOutcomeWords(
  outcome: EngineEventOf<'recovery_resolved'>['outcome'],
  recovery: RecoveryFold,
): string {
  if (
    recovery.seatSwitch !== undefined &&
    recovery.resolved?.action === 'switch-seat' &&
    (outcome === 'continued' || outcome === 'retry-current-task')
  ) {
    const taskId = recovery.prompted?.taskId ?? recovery.reset?.taskId;
    return taskId === undefined ? 'continued on new seat' : `${taskId} resumed on new seat`;
  }
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
      return stateTone('passed');
    case 'skipped-current-task':
    case 'aborted':
      return stateTone('attention');
    default:
      return assertNever(outcome);
  }
}

import type { EngineEvent } from '../../../../engine/events/types.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { ValidationStageSchema, type ValidationStage } from '../../../../core/schemas/enums.js';
import {
  implementerDoneFilesBlock,
  implementerExpandedDiffCardBlock,
} from '../blocks/implementer-diff-card.js';
import type { ConversationRowBlock, ConversationRowSegment, RowBuildContext } from '../types.js';
import { preformattedOutputBlock } from '../row-format/preformatted-block.js';
import { segmentedRow } from '../row-format/rows.js';
import { sanitizeRowDisplayText } from '../row-format/text.js';
import {
  reviewChecksSegments,
  reviewNoneSegments,
  validationStageNotes,
  validationSummarySegments,
} from './format.js';
import { fullSuiteNameRows, fullSuiteSegments } from './full-suite.js';
import { compositeBlock, rowsBlock, wrappedSegmentsBlock } from '../blocks/compose.js';
import { wrappedTextBlock } from '../blocks/wrapped-text.js';
import { CREW_SEAT_LABELS } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { truncateTerminalDisplayText } from '../../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { wrapWidthFor } from '../row-format/markers.js';

export function runningImplementerRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_running' }>,
  ctx: RowBuildContext,
): ConversationRowBlock | null {
  const fileHint = event.file ? `working on ${event.file}…` : 'working…';
  const streamLines =
    ctx.streaming.active && ctx.streaming.taskId === event.taskId
      ? ctx.streaming.lines.slice(0, 5)
      : [];

  return compositeBlock(keyPrefix, [
    wrappedTextBlock({
      keyPrefix: `${keyPrefix}-running-0`,
      text: fileHint,
      width: ctx.width,
      tone: 'textDim',
    }),
    ...streamLines.map((line, index) =>
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-stream-${index}`,
        text: line,
        width: ctx.width,
        tone: 'textDim',
      }),
    ),
  ]);
}

export function implementerDoneRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_done' }>,
  ctx: RowBuildContext,
  expanded: boolean,
): ConversationRowBlock | null {
  const header = implementerDoneFilesBlock(keyPrefix, event, ctx.width, false);
  const kept = event.kept ?? [];
  if (event.noChange === true) {
    const verdict: ConversationRowSegment[] =
      kept.length === 0
        ? [{ text: 'no change needed', tone: 'textDim' }]
        : [
            { text: KEPT_WORK, tone: 'textDim' },
            { text: SOFT_SEP, tone: 'textDim' },
            { text: 'no further change', tone: 'textDim' },
          ];
    return compositeBlock(keyPrefix, [
      header,
      wrappedSegmentsBlock({
        keyPrefix: `${keyPrefix}-summary-1`,
        segments: [
          { text: 'verified', tone: stateTone('passed') },
          { text: SOFT_SEP, tone: 'textDim' },
          ...verdict,
        ],
        width: ctx.width,
      }),
    ]);
  }

  const body = expanded
    ? (implementerExpandedDiffCardBlock(keyPrefix, event, ctx) ?? header)
    : header;
  if (kept.length === 0) return body;
  // The header names what this call changed; the kept files it did not touch again follow here,
  // so no file is named twice.
  const changed = new Set(event.files ?? []);
  const keptOnly = kept.filter((file) => !changed.has(file));
  return compositeBlock(keyPrefix, [
    body,
    wrappedTextBlock({
      keyPrefix: `${keyPrefix}-kept`,
      text: [KEPT_WORK, ...keptOnly.map(sanitizeRowDisplayText)].join(SOFT_SEP),
      width: ctx.width,
      tone: 'textDim',
    }),
  ]);
}

export function implementerFailedRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_failed' }>,
  width: number,
  expanded: boolean,
): ConversationRowBlock | null {
  const { value } = implementerFailureCard(event, width, expanded);
  return wrappedSegmentsBlock({
    keyPrefix,
    segments: [
      { text: CREW_SEAT_LABELS.build, tone: CREW_SEAT_ROLES.build },
      { text: ' ', tone: 'textDim' },
      { text: 'failed', tone: stateTone('failed') },
      ...(value ? [{ text: `  ${value}`, tone: 'textDim' as const }] : []),
    ],
    width,
    kind: 'card',
  });
}

/** A call that continued an interrupted attempt of its brief kept that attempt's files. */
const KEPT_WORK = "kept the interrupted attempt's work";

export function validateRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'validate' }>,
  width: number,
): ConversationRowBlock | null {
  const stage = failedValidationStage(event);
  const command = stage === undefined ? undefined : event.commands?.[stage];
  // The strip is one line at every width, so a note appended to it is the first thing a narrow
  // terminal cuts — and the words that keep the row honest are exactly the ones that must survive.
  // They wrap on their own row, the way the baseline block carries its pre-existing sentence.
  const notes = validationStageNotes(event);

  return compositeBlock(keyPrefix, [
    rowsBlock(keyPrefix, [
      segmentedRow(`${keyPrefix}-summary`, validationSummarySegments(event), 'message'),
    ]),
    notes.length === 0
      ? null
      : wrappedTextBlock({
          keyPrefix: `${keyPrefix}-notes`,
          text: notes.join(', '),
          width,
          tone: 'textDim',
        }),
    event.status === 'done' && !event.passed && event.error
      ? preformattedOutputBlock({
          keyPrefix: `${keyPrefix}-error`,
          label: 'Error',
          // The header names the stage; the footer names the command. Carrying the command in both
          // put one string on screen twice, cut at two different columns because the two rows have
          // different budgets. It belongs at the foot, where it is the thing to act on.
          ...(stage === undefined ? {} : { meta: stage }),
          text: event.error,
          width,
          tone: 'error',
          ...(command === undefined ? {} : { moreHint: `run ${command}` }),
        })
      : null,
  ]);
}

function failedValidationStage(
  event: Extract<EngineEvent, { type: 'validate' }>,
): ValidationStage | undefined {
  return ValidationStageSchema.options.find(
    (stage) =>
      !event.stages[stage] &&
      event.skipped?.[stage] !== true &&
      (event.attempted === undefined || event.attempted[stage]),
  );
}

export function fullSuiteRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'full_suite' }>,
  width: number,
): ConversationRowBlock | null {
  return compositeBlock(keyPrefix, [
    wrappedSegmentsBlock({
      keyPrefix,
      segments: fullSuiteSegments(event, width),
      width,
      continuationIndent: 2,
    }),
    ...fullSuiteNameRows(event).map((row, index) =>
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-names-${index}`,
        ...row,
        width,
        tone: 'textDim',
      }),
    ),
  ]);
}

export function reviewChecksRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'review_checks' }>,
  width: number,
): ConversationRowBlock | null {
  return wrappedSegmentsBlock({
    keyPrefix,
    segments: reviewChecksSegments(event),
    width,
    continuationIndent: 2,
  });
}

export function reviewNoneRowBlock(keyPrefix: string, width: number): ConversationRowBlock | null {
  return wrappedSegmentsBlock({
    keyPrefix,
    segments: reviewNoneSegments(),
    width,
    continuationIndent: 2,
  });
}

export function escalateRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'escalate' }>,
  width: number,
): ConversationRowBlock | null {
  return compositeBlock(keyPrefix, [
    wrappedTextBlock({
      keyPrefix,
      text: `Escalate tier ${event.tier}${event.hint ? ' — hint' : ''}`,
      width,
      tone: 'textDim',
      bold: true,
    }),
    event.hint
      ? wrappedTextBlock({
          keyPrefix: `${keyPrefix}-hint`,
          text: `hint: ${event.hint}`,
          width,
          tone: 'textDim',
        })
      : null,
  ]);
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

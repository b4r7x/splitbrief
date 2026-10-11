import type { EngineEvent } from '../../../../engine/events/types.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { ValidationStageSchema, type ValidationStage } from '../../../../core/schemas/enums.js';
import {
  implementerDoneFilesBlock,
  implementerExpandedDiffCardBlock,
} from '../implementer-diff-card-block.js';
import type { ConversationRowBlock, RowBuildContext } from '../types.js';
import { preformattedOutputBlock } from '../row-format/preformatted-block.js';
import { segmentedRow } from '../row-format/rows.js';
import {
  fullSuiteSegments,
  reviewChecksDeclinedRows,
  reviewChecksSegments,
  validationStageNotes,
  validationSummarySegments,
} from '../event-format.js';
import {
  compositeBlock,
  rowsBlock,
  wrappedSegmentsBlock,
  wrappedTextBlock,
} from '../row-block-compose.js';

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
  if (event.noChange === true) {
    return compositeBlock(keyPrefix, [
      header,
      wrappedSegmentsBlock({
        keyPrefix: `${keyPrefix}-summary-1`,
        segments: [
          { text: 'verified', tone: stateTone('passed') },
          { text: SOFT_SEP, tone: 'textDim' },
          { text: 'no change needed', tone: 'textDim' },
        ],
        width: ctx.width,
      }),
    ]);
  }

  return expanded ? (implementerExpandedDiffCardBlock(keyPrefix, event, ctx) ?? header) : header;
}

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
  return wrappedSegmentsBlock({
    keyPrefix,
    segments: fullSuiteSegments(event),
    width,
    continuationIndent: 2,
  });
}

export function reviewChecksRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'review_checks' }>,
  width: number,
): ConversationRowBlock | null {
  return compositeBlock(keyPrefix, [
    wrappedSegmentsBlock({
      keyPrefix,
      segments: reviewChecksSegments(event),
      width,
      continuationIndent: 2,
    }),
    ...reviewChecksDeclinedRows(event).map((text, index) =>
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-declined-${index}`,
        text,
        width,
        tone: 'textDim',
        indent: 2,
        continuationIndent: 2,
      }),
    ),
  ]);
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

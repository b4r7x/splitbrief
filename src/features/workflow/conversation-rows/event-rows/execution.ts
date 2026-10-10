import type { EngineEvent } from '../../../../engine/events/types.js';
import { ValidationStageSchema, type ValidationStage } from '../../../../core/schemas/enums.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { implementerExpandedDiffCardBlock } from '../implementer-diff-card-block.js';
import type { ConversationRowBlock, RowBuildContext } from '../types.js';
import { sanitizeRowDisplayText } from '../row-format/text.js';
import { preformattedOutputBlock } from '../row-format/preformatted-block.js';
import { segmentedRow } from '../row-format/rows.js';
import {
  fullSuiteRow,
  fullSuiteTone,
  reviewChecksDeclinedRows,
  reviewChecksRow,
  reviewChecksTone,
  validationStageNotes,
  validationSummarySegments,
} from '../event-format.js';
import { compositeBlock, rowsBlock, wrappedTextBlock } from '../row-block-compose.js';

/** ` (+a -b)` when the call counted its lines; nothing when its baseline could not. */
function lineCounts(event: {
  linesAdded?: number | undefined;
  linesRemoved?: number | undefined;
}): string {
  return event.linesAdded === undefined || event.linesRemoved === undefined
    ? ''
    : ` (+${event.linesAdded} -${event.linesRemoved})`;
}

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
  const header = wrappedTextBlock({
    keyPrefix: `${keyPrefix}-header-0`,
    text: `${event.file}  ${formatDuration(event.duration)}`,
    width: ctx.width,
    tone: 'textDim',
  });

  if (!event.diff) {
    return compositeBlock(keyPrefix, [
      header,
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-summary-1`,
        // A review fix that verified the brief and edited nothing never reads as a code change;
        // the header above already names the file, so the verdict stands alone and never wraps.
        text:
          event.noChange === true
            ? 'verified · no change needed'
            : `${event.file}${lineCounts(event)}`,
        width: ctx.width,
        tone: 'textDim',
      }),
    ]);
  }

  const diffLines = sanitizeRowDisplayText(event.diff)
    .split('\n')
    .filter((line) => line.length > 0);
  if (!expanded || diffLines.length === 0) {
    return compositeBlock(keyPrefix, [
      header,
      wrappedTextBlock({
        keyPrefix: `${keyPrefix}-collapsed-1`,
        text: `${event.file}${lineCounts(event)}  ctrl+d`,
        width: ctx.width,
        tone: 'textDim',
      }),
    ]);
  }

  return implementerExpandedDiffCardBlock(keyPrefix, event, ctx);
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
  return wrappedTextBlock({
    keyPrefix,
    text: fullSuiteRow(event),
    width,
    tone: fullSuiteTone(event),
    continuationIndent: 2,
  });
}

export function reviewChecksRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'review_checks' }>,
  width: number,
): ConversationRowBlock | null {
  return compositeBlock(keyPrefix, [
    wrappedTextBlock({
      keyPrefix,
      text: reviewChecksRow(event),
      width,
      tone: reviewChecksTone(event),
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

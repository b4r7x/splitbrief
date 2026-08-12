import type { EngineEvent } from '../../../../engine/events/types.js';
import { ValidationStageSchema, type ValidationStage } from '../../../../core/schemas/enums.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { implementerExpandedDiffCardBlock } from '../implementer-diff-card-block.js';
import type { ConversationRowBlock, ConversationRowTone, RowBuildContext } from '../types.js';
import { sanitizeRowDisplayText } from '../row-format/text.js';
import { preformattedOutputBlock } from '../row-format/preformatted-block.js';
import { segmentedRow } from '../row-format/rows.js';
import { baselineValidationRow, validationSummarySegments } from '../event-format.js';
import { compositeBlock, rowsBlock, wrappedTextBlock } from '../row-block-compose.js';

export function runningImplementerRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_running' }>,
  ctx: RowBuildContext,
): ConversationRowBlock | null {
  const fileHint = event.file ? `generating ${event.file}...` : 'generating...';
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
        keyPrefix: `${keyPrefix}-stream-${index}-${index + 1}`,
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
        text: `${event.file} (+${event.linesAdded} -${event.linesRemoved})`,
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
        text: `${event.file} (+${event.linesAdded} -${event.linesRemoved})  ctrl+d`,
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

  return compositeBlock(keyPrefix, [
    rowsBlock(keyPrefix, [
      segmentedRow(`${keyPrefix}-summary`, validationSummarySegments(event), 'message'),
    ]),
    event.status === 'done' && !event.passed && event.error
      ? preformattedOutputBlock({
          keyPrefix: `${keyPrefix}-error`,
          label: 'error',
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

export function baselineValidationRowBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'validation_baseline' }>,
  width: number,
): ConversationRowBlock | null {
  const failingStages = ValidationStageSchema.options.filter(
    (stage) => event.failing?.[stage] === true,
  );
  const done = event.status === 'done';
  const tone: ConversationRowTone = done && failingStages.length === 0 ? 'success' : 'textDim';
  return compositeBlock(keyPrefix, [
    wrappedTextBlock({
      keyPrefix,
      text: baselineValidationRow(event),
      width,
      tone,
    }),
    done && failingStages.length > 0
      ? wrappedTextBlock({
          keyPrefix: `${keyPrefix}-preexisting`,
          text: `already failing before any task ran: ${failingStages.join(', ')} — pre-existing failures will not fail this run's tasks`,
          width,
          tone: 'warning',
        })
      : null,
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
      text: `escalate tier ${event.tier}${event.hint ? ' — hint' : ''}`,
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

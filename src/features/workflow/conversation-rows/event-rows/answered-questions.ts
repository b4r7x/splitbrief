import type { AnsweredQuestion } from '../../../../core/schemas/question.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { rowsBlock } from '../row-block-compose.js';
import { wrapWidthFor } from '../row-markers.js';
import { blankRow, row, segmentedRow } from '../row-format/rows.js';
import { wrappedRowTexts } from '../row-format/text.js';
import type { ConversationRow, ConversationRowBlock } from '../types.js';

// A greedy wrap strands the last line as one lone word at some widths; pulling the previous
// line's last word down keeps the card's ragged edge from hanging a single word.
function wrappedLines(text: string, width: number): string[] {
  const lines = wrappedRowTexts(text, width);
  const last = lines.length - 1;
  if (last < 1) return lines;
  const previous = (lines[last - 1] ?? '').trimEnd();
  const lone = (lines[last] ?? '').trim();
  const cut = previous.lastIndexOf(' ');
  if (lone === '' || lone.includes(' ') || cut === -1) return lines;
  const moved = previous.slice(cut + 1);
  if (moved.length + 1 + lone.length > width) return lines;
  return [...lines.slice(0, last - 1), previous.slice(0, cut), `${moved} ${lone}`];
}

// The last pair carries the widest number label, so its width plus one space is the column every
// question body starts at; answers share that column, the change of voice carried by tone alone.
// Pairs carry their own separation: the bold number labels, not blank rows between them.
export function answeredQuestionsRowBlock(input: {
  keyPrefix: string;
  qa: readonly AnsweredQuestion[];
  width: number;
}): ConversationRowBlock | null {
  if (input.qa.length === 0) return null;
  const gutter = `${input.qa.length}.`.length + 1;
  const indent = ' '.repeat(gutter);
  const bodyWidth = Math.max(1, wrapWidthFor('message', input.width) - gutter);
  const rows: ConversationRow[] = [
    segmentedRow(
      `${input.keyPrefix}-label`,
      [
        { text: 'Answered · ', tone: 'textDim', bold: true },
        { text: countNoun(input.qa.length, 'question'), tone: 'planner', bold: true },
      ],
      'prompt',
    ),
    blankRow(`${input.keyPrefix}-gap`),
  ];
  input.qa.forEach((pair, index) => {
    const label = `${index + 1}.`;
    wrappedLines(pair.question, bodyWidth).forEach((line, offset) => {
      if (offset > 0) {
        rows.push(
          row({
            key: `${input.keyPrefix}-q-${index}-${offset}`,
            text: `${indent}${line}`,
            tone: 'planner',
          }),
        );
        return;
      }
      rows.push(
        segmentedRow(
          `${input.keyPrefix}-q-${index}-0`,
          [
            { text: label, tone: 'planner', bold: true },
            { text: ' '.repeat(gutter - label.length) },
            { text: line, tone: 'planner' },
          ],
          'message',
        ),
      );
    });
    if (pair.answer.trim() === '') return;
    pair.answer
      .split('\n')
      .flatMap((answerLine) => wrappedLines(answerLine, bodyWidth))
      .forEach((line, offset) => {
        rows.push(
          row({
            key: `${input.keyPrefix}-a-${index}-${offset}`,
            text: `${indent}${line}`,
            tone: 'text',
          }),
        );
      });
  });
  return rowsBlock(input.keyPrefix, rows);
}

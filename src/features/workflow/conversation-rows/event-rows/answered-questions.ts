import type { AnsweredQuestion } from '../../../../core/schemas/question.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { rowsBlock } from '../row-block-compose.js';
import { wrapWidthFor } from '../row-markers.js';
import { row, segmentedRow } from '../row-format/rows.js';
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

// The wrapper keeps the space it broke on (`trim: false`): usually it trails the line above, but at
// some widths it wedges onto the head of the continuation, which would start that line one cell
// deeper than the line it continues. Trimming the head puts every continuation back on its own
// row's column, and a continuation the trim leaves empty is dropped rather than painted blank.
function continuationHead(line: string): string {
  return line.trimStart();
}

// The last pair carries the widest number label, so its width plus one space is the column the
// question hangs at; an answer starts on the content column with every other row that carries no
// mark, the change of voice carried by tone alone.
// Separation is carried by weight, not blank rows: the bold header sits directly on the first
// pair — the way an activity header sits on its children — and the bold number labels separate
// the pairs.
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
  ];
  input.qa.forEach((pair, index) => {
    const label = `${index + 1}.`;
    wrappedLines(pair.question, bodyWidth).forEach((line, offset) => {
      if (offset > 0) {
        const continued = continuationHead(line);
        if (continued === '') return;
        rows.push(
          row({
            key: `${input.keyPrefix}-q-${index}-${offset}`,
            text: `${indent}${continued}`,
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
      .flatMap((answerLine, answerIndex) =>
        wrappedLines(answerIndex === 0 ? `You → ${answerLine}` : answerLine, bodyWidth).map(
          (line, lineOffset) => ({
            line,
            continuation: lineOffset > 0,
          }),
        ),
      )
      .forEach(({ line, continuation }, offset) => {
        const text = continuation ? continuationHead(line) : line;
        if (continuation && text === '') return;
        rows.push(
          row({
            key: `${input.keyPrefix}-a-${index}-${offset}`,
            text,
            tone: 'text',
          }),
        );
      });
  });
  return rowsBlock(input.keyPrefix, rows);
}

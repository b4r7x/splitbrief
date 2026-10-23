import type { AnsweredQuestion, ClarificationQuestion } from '../../../../core/schemas/question.js';
import { questionLine } from '../../../../core/state/planning-conversation.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { rowsBlock } from '../row-block-compose.js';
import { wrapWidthFor } from '../row-markers.js';
import { row, segmentedRow } from '../row-format/rows.js';
import { wrappedPrefixedRowTexts, wrappedRowTexts } from '../row-format/text.js';
import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowKind,
  ConversationRowTone,
} from '../types.js';

// A greedy wrap strands the last line as one lone word at some widths; pulling the previous
// line's last word down keeps the card's ragged edge from hanging a single word.
function wrappedLines(text: string, width: number, prefix: string): string[] {
  const lines = wrappedPrefixedRowTexts(text, width, prefix);
  const last = lines.length - 1;
  if (last < 1) return lines;
  const previousLine = lines[last - 1] ?? '';
  const lastLine = lines[last] ?? '';
  if (!previousLine.endsWith(' ') && !lastLine.startsWith(' ')) return lines;
  const previous = previousLine.trimEnd();
  const lone = lastLine.trim();
  const cut = previous.lastIndexOf(' ');
  if (lone === '' || lone.includes(' ') || cut === -1) return lines;
  if (last === 1 && cut < prefix.length) return lines;
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
  const rows = [roundHeader(input.keyPrefix, 'Answered', input.qa.length, 'prompt')];
  input.qa.forEach((pair, index) => {
    const label = `${index + 1}.`;
    wrappedLines(pair.question, bodyWidth, '').forEach((line, offset) => {
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
            { text: ' '.repeat(gutter - label.length), tone: 'text' },
            { text: line, tone: 'planner' },
          ],
          'message',
        ),
      );
    });
    if (pair.answer.trim() === '') return;
    rows.push(...replyRows(`${input.keyPrefix}-a-${index}`, pair.answer, bodyWidth));
  });
  return rowsBlock(input.keyPrefix, rows);
}

/**
 * A round the user answered in their own words: the reply answers the whole round, so it follows
 * every question once rather than pairing with the last. The questions keep the `·` lines of the
 * `Unanswered` row they replace, without its options.
 */
export function repliedQuestionsRowBlock(input: {
  keyPrefix: string;
  questions: readonly ClarificationQuestion[];
  reply: string;
  width: number;
}): ConversationRowBlock | null {
  const bodyWidth = Math.max(1, wrapWidthFor('message', input.width) - 2);
  return rowsBlock(input.keyPrefix, [
    roundHeader(input.keyPrefix, 'Answered', input.questions.length, 'prompt'),
    ...questionLineRows(
      input.keyPrefix,
      input.questions.map((question) => question.text),
      bodyWidth,
      'planner',
    ),
    ...replyRows(`${input.keyPrefix}-a`, input.reply, bodyWidth),
  ]);
}

function roundHeader(
  keyPrefix: string,
  word: 'Answered' | 'Unanswered',
  count: number,
  kind: ConversationRowKind,
): ConversationRow {
  return segmentedRow(
    `${keyPrefix}-label`,
    [
      { text: `${word} · `, tone: 'textDim', bold: true },
      { text: countNoun(count, 'question'), tone: 'planner', bold: true },
    ],
    kind,
  );
}

// The reply opens on the content column after `You → `; its wrapped and following lines stay there.
function replyRows(keyPrefix: string, reply: string, bodyWidth: number): ConversationRow[] {
  const rows: ConversationRow[] = [];
  reply
    .split('\n')
    .flatMap((answerLine, answerIndex) =>
      wrappedLines(answerLine, bodyWidth, answerIndex === 0 ? 'You → ' : '').map(
        (line, lineOffset) => ({
          line,
          continuation: lineOffset > 0,
        }),
      ),
    )
    .forEach(({ line, continuation }, offset) => {
      const text = continuation ? continuationHead(line) : line;
      if (continuation && text === '') return;
      rows.push(row({ key: `${keyPrefix}-${offset}`, text, tone: 'text' }));
    });
  return rows;
}

// One `·` line per question; a wrapped question hangs two cells in, under its own text.
function questionLineRows(
  keyPrefix: string,
  lines: readonly string[],
  bodyWidth: number,
  tone: ConversationRowTone,
): ConversationRow[] {
  return lines.flatMap((questionText, index) =>
    wrappedRowTexts(questionText, bodyWidth).flatMap((line, offset) => {
      const text = line.trim();
      if (text === '') return [];
      return [
        row({
          key: `${keyPrefix}-q-${index}-${offset}`,
          text: `${offset === 0 ? '·' : ' '} ${text}`,
          tone,
        }),
      ];
    }),
  );
}

/**
 * A round still waiting for its answer, in the voice of `Answered`; each question keeps one dim line
 * with what it offered. The user has not acted yet, so the header carries no mark.
 */
export function unansweredQuestionsRowBlock(input: {
  keyPrefix: string;
  questions: readonly ClarificationQuestion[];
  width: number;
}): ConversationRowBlock | null {
  if (input.questions.length === 0) return null;
  const bodyWidth = Math.max(1, wrapWidthFor('message', input.width) - 2);
  return rowsBlock(input.keyPrefix, [
    roundHeader(input.keyPrefix, 'Unanswered', input.questions.length, 'message'),
    ...questionLineRows(input.keyPrefix, input.questions.map(questionLine), bodyWidth, 'textDim'),
  ]);
}

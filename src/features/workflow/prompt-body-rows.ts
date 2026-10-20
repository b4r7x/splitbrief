import { SOFT_SEP } from '../../core/separators.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
  segmentsForRowText,
} from '../../utils/display-text.js';
import { assertNever } from '../../utils/type-guards.js';
import { wrapHard } from '../../utils/wrap.js';
import type { ConversationRowSegment } from './conversation-rows/types.js';
import {
  FACT_INDENT,
  FAILED_REVIEW_MARKER,
  isActionRowLine,
  passHeadlinePrefix,
  type PromptRow,
  promptRowsToString,
  recommendedRowPrefix,
} from './recovery-prompt.js';

const MIN_PROMPT_WIDTH = 1;
const GRID_MIN_WIDTH = 52;
const RECOMMENDED_TAIL = ' recommended';
const ACTION_ROW_PREFIX = /^\[(.+?)\]\s*/;

export type PromptBodyLine =
  | { kind: 'blank' }
  | { kind: 'message-line'; text: string; parts?: readonly ConversationRowSegment[] }
  | { kind: 'headline'; row: Extract<PromptRow, { kind: 'headline' }> }
  | { kind: 'facts-line'; text: string }
  | { kind: 'facts-grid-pair'; left: string; right: string }
  | { kind: 'action'; key: string; keyWidth: number; text: string; recommended: boolean }
  | { kind: 'note'; text: string };

const BLANK_ROW: PromptBodyLine = { kind: 'blank' };

function clean(text: string, multiline = false): string {
  return sanitizeTerminalDisplayText(text, { preserveLineBreaks: multiline });
}

function normalizeFactLines(items: readonly string[]): string[] {
  return items
    .flatMap((text) => clean(text, true).split('\n'))
    .filter((line) => line.trim().length > 0);
}

export function splitActionRow(text: string): { key: string; text: string } {
  const match = ACTION_ROW_PREFIX.exec(text);
  if (match === null) return { key: '', text };
  return { key: match[1] ?? '', text: text.slice(match[0].length) };
}

export function fitRecommendedText(text: string, room: number): string {
  const tailWidth = getTerminalCellWidth(RECOMMENDED_TAIL);
  if (getTerminalCellWidth(text) + tailWidth <= room) return text;
  const head = text.split(SOFT_SEP)[0] ?? '';
  return truncateTerminalDisplayText(head, Math.max(0, room - tailWidth));
}

// Prompts cross the question-mode UI channel as flat strings (the channel is typed
// `hint: string`), so the structured rows the builders produce are serialized via
// promptRowsToString and reconstructed here. tone and grid are recovered from the
// shared headline markers so the renderer reproduces the builders' intent exactly.
function parseHeadline(headline: string): Extract<PromptRow, { kind: 'headline' }> {
  const passPrefix = passHeadlinePrefix();
  if (headline.startsWith(passPrefix)) {
    return { kind: 'headline', tone: 'pass', text: headline.slice(passPrefix.length) };
  }
  const marker = headline.indexOf(FAILED_REVIEW_MARKER);
  if (marker !== -1) {
    return {
      kind: 'headline',
      tone: 'failed',
      text: headline.slice(0, marker),
      detail: headline.slice(marker + FAILED_REVIEW_MARKER.length),
    };
  }
  return { kind: 'headline', tone: 'text', text: headline };
}

function parsePromptRows(prompt: string): PromptRow[] {
  const lines = clean(prompt, true).split('\n');
  const headline = parseHeadline(lines[0] ?? '');
  const body = lines.slice(1);
  const actionStart = body.findIndex(isActionRowLine);
  const factLines = normalizeFactLines(actionStart === -1 ? body : body.slice(0, actionStart));
  const actionLines = actionStart === -1 ? [] : body.slice(actionStart);

  if (factLines.length === 0 && actionLines.length === 0) {
    return headline.tone === 'text' ? [{ kind: 'message', text: headline.text }] : [headline];
  }

  const rows: PromptRow[] = [headline];
  if (factLines.length > 0) {
    rows.push(
      { kind: 'blank' },
      { kind: 'facts', items: factLines, grid: headline.tone === 'pass' },
    );
  }
  if (actionLines.length > 0) {
    rows.push({ kind: 'blank' });
    for (const line of actionLines) {
      if (line.trim().length === 0) {
        rows.push({ kind: 'blank' });
        continue;
      }
      if (!isActionRowLine(line)) {
        rows.push({ kind: 'note', text: line });
        continue;
      }
      const rowPrefix = recommendedRowPrefix();
      const recommended = line.startsWith(rowPrefix);
      rows.push({
        kind: 'action',
        text: recommended ? line.slice(rowPrefix.length) : line,
        recommended,
      });
    }
  }
  return rows;
}

function wrappedMessageLines(text: string, width: number): PromptBodyLine[] {
  return wrapHard(clean(text, true), width)
    .split('\n')
    .map((line) => ({ kind: 'message-line', text: line }));
}

// A fact that outruns its width keeps its own column: the continuation hangs under the first
// line rather than starting at the border, so a wrapped fact still reads as one fact.
// A break that lands on a space leaves that space at the head of the next line, so a wrapped
// continuation drops it; a line the fact itself starts keeps its own indentation.
function wrappedFactLines(item: string, width: number): PromptBodyLine[] {
  return wrapHard(item, Math.max(1, width - FACT_INDENT.length))
    .split('\n')
    .map((line, index) => (index === 0 ? line : line.trimStart()))
    .map((line) => ({ kind: 'facts-line', text: `${FACT_INDENT}${line}` }));
}

function factRows(row: Extract<PromptRow, { kind: 'facts' }>, width: number): PromptBodyLine[] {
  const rows: PromptBodyLine[] = [];
  if (row.grid && width >= GRID_MIN_WIDTH) {
    for (let index = 0; index < row.items.length; index += 2) {
      const left = row.items[index] ?? '';
      const right = row.items[index + 1];
      if (right === undefined) {
        rows.push(...wrappedFactLines(left, width));
        continue;
      }
      rows.push({
        kind: 'facts-grid-pair',
        left: clean(left),
        right: clean(right),
      });
    }
    return rows;
  }

  for (const item of row.items) {
    rows.push(...wrappedFactLines(item, width));
  }
  return rows;
}

function promptBodyLinesForRow(row: PromptRow, width: number, keyWidth: number): PromptBodyLine[] {
  switch (row.kind) {
    case 'blank':
      return [{ kind: 'blank' }];
    case 'message':
      return wrappedMessageLines(row.text, width);
    case 'headline':
      return [{ kind: 'headline', row }];
    case 'facts':
      return factRows(row, width);
    case 'action': {
      const { key, text } = splitActionRow(row.text);
      return [{ kind: 'action', key, keyWidth, text, recommended: row.recommended }];
    }
    case 'note':
      return [{ kind: 'note', text: row.text }];
    default:
      return assertNever(row);
  }
}

export function promptBodyRows(
  prompt: string | readonly PromptRow[],
  width: number,
): PromptBodyLine[] {
  const promptWidth = Math.max(MIN_PROMPT_WIDTH, width);
  const rows = parsePromptRows(typeof prompt === 'string' ? prompt : promptRowsToString(prompt));
  const headline = rows[0];
  const sourceHeadline = typeof prompt === 'string' ? undefined : prompt[0];
  if (
    sourceHeadline?.kind === 'headline' &&
    (headline?.kind === 'headline' || headline?.kind === 'message')
  ) {
    const text = headline.text;
    const parts = sourceHeadline.parts?.map((part) => ({ ...part, text: clean(part.text, true) }));
    rows[0] = {
      ...sourceHeadline,
      text,
      ...(headline.kind === 'headline' &&
        headline.detail !== undefined && { detail: headline.detail }),
      ...(parts !== undefined && { parts: segmentsForRowText(parts, text) }),
    };
  }
  const onlyRow = rows.length === 1 ? rows[0] : undefined;
  if (onlyRow?.kind === 'headline' && onlyRow.tone === 'attention') {
    const parts = onlyRow.parts;
    const text = onlyRow.text;
    let start = 0;
    return wrappedMessageLines(text, promptWidth).map((row) => {
      if (row.kind !== 'message-line') return row;
      const result = { ...row, parts: segmentsForRowText(parts, row.text, start) };
      start += row.text.length;
      return result;
    });
  }
  const keyWidth = rows.reduce(
    (widest, row) =>
      row.kind === 'action'
        ? Math.max(widest, getTerminalCellWidth(splitActionRow(row.text).key))
        : widest,
    0,
  );
  return rows.flatMap((row) => promptBodyLinesForRow(row, promptWidth, keyWidth));
}

/**
 * What a panel too short for its prompt keeps: the headline that says what
 * happened and every action row, because a halt whose choices are scrolled off
 * screen is a halt the operator cannot answer. Facts are what gives way, from
 * the bottom, and the last kept slot stays blank so the facts do not run into
 * the keys.
 */
export function clipPromptBodyRows(
  rows: readonly PromptBodyLine[],
  height: number,
): PromptBodyLine[] {
  if (height <= 0) return [];
  if (rows.length <= height) return [...rows];
  const actionStart = rows.findIndex((row) => row.kind === 'action');
  if (actionStart <= 0) return rows.slice(0, height);
  const head = rows.slice(0, 1);
  const tail = rows.slice(actionStart).slice(0, Math.max(0, height - head.length));
  const facts = rows.slice(1, actionStart).filter((row) => row.kind !== 'blank');
  const room = height - head.length - tail.length;
  const kept = room > 1 ? [...facts.slice(0, room - 1), BLANK_ROW] : facts.slice(0, room);
  return [...head, ...kept, ...tail];
}

export function countPromptBodyRows(prompt: string | readonly PromptRow[], width: number): number {
  return promptBodyRows(prompt, width).length;
}

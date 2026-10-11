import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  splitTerminalGraphemes,
  segmentsForRowText,
} from '../../../../utils/display-text.js';
import { wrapHard } from '../../../../utils/wrap.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import type { ConversationRowSegment, ConversationRowTone } from '../types.js';

const MIN_ROW_WIDTH = 1;
const BOUND_SEP_DOT = `${SOFT_SEP.trim()} `;
const LINE_BREAK_PLACEHOLDER_PREFIX = `\ue000${SPLITBRIEF_IDENTITY.slug}-line-break`;

// Printable ASCII has one cell per character and carries no escape sequence a wrapper must track,
// so `length` is the exact rendered width.
const PRINTABLE_ASCII_ROW = /^[ -~]*$/;

export function sanitizeRowDisplayText(text: string): string {
  if (!text.includes('\n')) return sanitizeTerminalDisplayText(text);

  const placeholder = unusedLineBreakPlaceholder(text);
  return sanitizeTerminalDisplayText(text.replaceAll('\n', placeholder)).replaceAll(
    placeholder,
    '\n',
  );
}

function unusedLineBreakPlaceholder(text: string): string {
  let index = 0;
  let placeholder = `${LINE_BREAK_PLACEHOLDER_PREFIX}-${index}\ue000`;
  while (text.includes(placeholder)) {
    index += 1;
    placeholder = `${LINE_BREAK_PLACEHOLDER_PREFIX}-${index}\ue000`;
  }
  return placeholder;
}

// A line that already fits has nothing to wrap, and wrap-ansi charges for the answer anyway: it
// measures every space-separated word through string-width and then walks the result grapheme by
// grapheme. That is ~250us a line, so a 10k-line tool output spent seconds laying out before it
// could paint. Sanitizing has already removed every escape sequence, so for printable ASCII within
// the width the wrapper provably returns the string unchanged and can be skipped.
export function wrappedRowTexts(text: string, width: number): string[] {
  const wrapWidth = Math.max(MIN_ROW_WIDTH, width);
  const sanitized = sanitizeRowDisplayText(text);
  if (sanitized.length <= wrapWidth && PRINTABLE_ASCII_ROW.test(sanitized)) return [sanitized];
  return wrapHard(sanitized, wrapWidth).split('\n');
}

export function wrappedPrefixedRowTexts(text: string, width: number, prefix: string): string[] {
  const wrapWidth = Math.max(MIN_ROW_WIDTH, width);
  const boundPrefix = prefix.replaceAll(' ', '\u00a0');
  const source = sanitizeRowDisplayText(`${boundPrefix}${text}`);
  const lines: string[] = [];

  for (const sourceLine of source.split('\n')) {
    let line = '';
    for (let word of sourceLine.split(/( +)/u)) {
      if (!word.includes('/')) {
        const wrapped = wrappedRowTexts(`${line}${word}`, wrapWidth);
        wrapped.forEach((part, index) => {
          if (index < wrapped.length - 1) lines.push(part);
          else line = part;
        });
        continue;
      }

      while (getTerminalCellWidth(`${line}${word}`) > wrapWidth) {
        const room = wrapWidth - getTerminalCellWidth(line);
        if (room <= 0) {
          lines.push(line);
          line = '';
          continue;
        }
        let head = '';
        let cells = 0;
        for (const grapheme of splitTerminalGraphemes(word)) {
          const graphemeCells = getTerminalCellWidth(grapheme);
          if (head !== '' && cells + graphemeCells > room) break;
          head += grapheme;
          cells += graphemeCells;
        }
        const slash = head.lastIndexOf('/');
        const fitting = slash < 0 ? head : head.slice(0, slash + 1);
        if (getTerminalCellWidth(fitting) > room && line !== '') {
          lines.push(line);
          line = '';
          continue;
        }
        lines.push(`${line}${fitting}`);
        line = '';
        word = word.slice(fitting.length);
      }
      line += word;
    }
    lines.push(line);
  }
  return lines.map((line) => line.replace(boundPrefix, prefix));
}

// The wrapper keeps the space it broke on (`trim: false`): usually it trails the line above, but
// when the word before the break fills the row exactly, the space leads the continuation instead
// and starts it one cell off its row's column. Prose continues from the break, never from the space
// in it, so a continuation drops that one cell.
//
// A row joins its parts with SOFT_SEP, and a break after its dot leaves the dot trailing the line
// above. A no-break space binds the dot to the part it introduces while the row wraps, so the row
// breaks before the dot; soft continuations drop the dot before restoring plain separator spaces.
export function wrappedProseTexts(text: string, width: number): string[] {
  return text
    .split('\n')
    .flatMap((line) => wrappedProseLineParts(line, width).map((part) => part.text));
}

function wrappedProseLineParts(text: string, width: number): { text: string; start: number }[] {
  let offset = 0;
  return wrappedRowTexts(text.replaceAll(SOFT_SEP, ` ${BOUND_SEP_DOT}`), width).map(
    (line, index) => {
      let trim = index > 0 && line.startsWith(' ') ? 1 : 0;
      if (index > 0 && line.startsWith(BOUND_SEP_DOT, trim)) trim += BOUND_SEP_DOT.length;
      const part = {
        text: line.slice(trim).replaceAll(BOUND_SEP_DOT, `${SOFT_SEP.trim()} `),
        start: offset + trim,
      };
      offset += line.length;
      return part;
    },
  );
}

export function wrappedProseSegments(
  segments: readonly ConversationRowSegment[],
  width: number,
  indent = 0,
  continuationIndent = 0,
): ConversationRowSegment[][] {
  const clean = segments.map((segment) => ({
    ...segment,
    text: sanitizeRowDisplayText(segment.text),
  }));
  const text = clean.map((segment) => segment.text).join('');
  const rows: ConversationRowSegment[][] = [];
  let offset = 0;
  for (const sourceLine of text.split('\n')) {
    let parts = wrappedProseLineParts(sourceLine, Math.max(1, width - indent));
    const first = parts[0];
    if (continuationIndent > 0 && first !== undefined && parts.length > 1) {
      let start = first.text.length;
      if (sourceLine[start] === ' ') start += 1;
      if (sourceLine.startsWith(SOFT_SEP, start - 1)) start += SOFT_SEP.length - 1;
      parts = [
        first,
        ...wrappedProseLineParts(
          sourceLine.slice(start),
          Math.max(1, width - indent - continuationIndent),
        ).map((part) => ({ ...part, start: start + part.start })),
      ];
    }
    for (const [index, part] of parts.entries()) {
      const padding = ' '.repeat(indent + (index === 0 ? 0 : continuationIndent));
      rows.push([
        ...(padding === '' ? [] : [{ text: padding, tone: 'textDim' as const }]),
        ...segmentsForRowText(clean, part.text, offset + part.start),
      ]);
    }
    offset += sourceLine.length + 1;
  }
  return rows;
}

export function separatedSpans(text: string, tone: ConversationRowTone): ConversationRowSegment[] {
  return text
    .split(SOFT_SEP)
    .flatMap((part, index) => [
      ...(index === 0
        ? []
        : [{ text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment]),
      ...(part === '' ? [] : [{ text: part, tone }]),
    ]);
}

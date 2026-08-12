import { sanitizeTerminalDisplayText } from '../../../../utils/display-text.js';
import { wrapHard } from '../../../../utils/wrap.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';

const MIN_ROW_WIDTH = 1;
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

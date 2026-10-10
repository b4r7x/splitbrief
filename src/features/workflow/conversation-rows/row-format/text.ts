import { sanitizeTerminalDisplayText } from '../../../../utils/display-text.js';
import { wrapHard } from '../../../../utils/wrap.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';
import { SOFT_SEP } from '../../../../core/separators.js';

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

// The wrapper keeps the space it broke on (`trim: false`): usually it trails the line above, but
// when the word before the break fills the row exactly, the space leads the continuation instead
// and starts it one cell off its row's column. Prose continues from the break, never from the space
// in it, so a continuation drops that one cell.
//
// A row joins its parts with SOFT_SEP, and a break after its dot leaves the dot trailing the line
// above. A no-break space binds the dot to the part it introduces while the row wraps, so the row
// breaks before the dot; soft continuations drop the dot before restoring plain separator spaces.
export function wrappedProseTexts(text: string, width: number): string[] {
  return text.split('\n').flatMap((sourceLine) =>
    wrappedRowTexts(sourceLine.replaceAll(SOFT_SEP, ` ${BOUND_SEP_DOT}`), width).map(
      (line, index) => {
        let continuation = index > 0 && line.startsWith(' ') ? line.slice(1) : line;
        if (index > 0 && continuation.startsWith(BOUND_SEP_DOT)) {
          continuation = continuation.slice(BOUND_SEP_DOT.length);
        }
        return continuation.replaceAll(BOUND_SEP_DOT, `${SOFT_SEP.trim()} `);
      },
    ),
  );
}

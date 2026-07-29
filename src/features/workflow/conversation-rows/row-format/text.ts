import { sanitizeTerminalDisplayText } from '../../../../utils/display-text.js';
import { wrapHard } from '../../../../utils/wrap.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';

const MIN_ROW_WIDTH = 1;
const LINE_BREAK_PLACEHOLDER_PREFIX = `\ue000${SPLITBRIEF_IDENTITY.slug}-line-break`;

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

export function wrappedRowTexts(text: string, width: number): string[] {
  return wrapHard(sanitizeRowDisplayText(text), Math.max(MIN_ROW_WIDTH, width)).split('\n');
}

export function countWrappedRowTexts(text: string, width: number): number {
  return wrappedRowTexts(text, width).length;
}

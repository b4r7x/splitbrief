import { ELLIPSIS, graphemes } from '../../utils/display-text.js';
import { wrapHard } from '../../utils/wrap.js';

export interface FeedbackMessageParts {
  prefix: string;
  title: string;
  suffix: string;
}

export type FeedbackMessageInput = FeedbackMessageParts | string;

interface FeedbackBox {
  maxWidth: number;
  maxRows: number;
}

function fitsBox(text: string, box: FeedbackBox): boolean {
  if (box.maxWidth <= 0) return text.length === 0;
  return wrapHard(text, box.maxWidth).split('\n').length <= box.maxRows;
}

/**
 * The longest whole-grapheme head of `text` whose `render` fits the box. A cut never splits a
 * cluster, so each kept unit has a fixed width and the fit grows monotonically with the head.
 */
function longestFittingHead(
  text: string,
  render: (head: string) => string,
  box: FeedbackBox,
): string {
  const parts = graphemes(text);
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fitsBox(render(parts.slice(0, mid).join('')), box)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return render(parts.slice(0, low).join(''));
}

function truncateToBox(text: string, box: FeedbackBox): string {
  if (box.maxWidth <= 0) return '';
  if (fitsBox(text, box)) return text;
  if (!fitsBox(ELLIPSIS, box)) return '';
  return longestFittingHead(text, (head) => `${head}${ELLIPSIS}`, box);
}

export function matchKnownFeedbackMessage(
  message: string,
  prefix: string,
  suffix: string,
): FeedbackMessageParts | null {
  if (!message.startsWith(prefix) || !message.endsWith(suffix)) return null;
  return {
    prefix,
    title: message.slice(prefix.length, message.length - suffix.length),
    suffix,
  };
}

function fitText(message: FeedbackMessageInput, text: string, box: FeedbackBox): string {
  if (fitsBox(text, box)) return text;
  if (typeof message === 'string') return truncateToBox(message, box);

  const emptyTitle = `${message.prefix}${message.suffix}`;
  if (!fitsBox(emptyTitle, box)) return truncateToBox(text, box);

  const ellipsizedTitle = `${message.prefix}${ELLIPSIS}${message.suffix}`;
  if (!fitsBox(ellipsizedTitle, box)) return emptyTitle;

  return longestFittingHead(
    message.title,
    (head) => `${message.prefix}${head}${ELLIPSIS}${message.suffix}`,
    box,
  );
}

/**
 * The message laid out in a box of `width` cells by `maxRows` rows: it wraps at word boundaries,
 * one row per line, and only a message that passes the last row is cut, with an ellipsis. A wrapped
 * message takes the narrowest width that keeps its row count, so its rows come out even.
 */
export function fitFeedbackMessage(
  message: FeedbackMessageInput,
  { width, maxRows }: { width: number; maxRows: number },
): string {
  const text =
    typeof message === 'string' ? message : `${message.prefix}${message.title}${message.suffix}`;
  if (!Number.isFinite(width)) return text;

  const max = Math.max(0, Math.floor(width));
  const fitted = fitText(message, text, { maxWidth: max, maxRows });
  const rowCount = wrapHard(fitted, max).split('\n').length;
  if (rowCount === 1) return fitted;

  let low = 1;
  let high = max;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fitsBox(fitted, { maxWidth: mid, maxRows: rowCount })) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return wrapHard(fitted, low)
    .split('\n')
    .map((row) => row.trim())
    .join('\n');
}

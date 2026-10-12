import { ELLIPSIS, graphemes } from '../../utils/display-text.js';
import { wrapHard } from '../../utils/wrap.js';

export interface FeedbackMessageParts {
  prefix: string;
  title: string;
  suffix: string;
}

export type FeedbackMessageInput = FeedbackMessageParts | string;

function fitsDisplayWidth(text: string, maxWidth: number): boolean {
  if (maxWidth <= 0) return text.length === 0;
  return !wrapHard(text, maxWidth).includes('\n');
}

/**
 * The longest whole-grapheme head of `text` whose `render` fits `maxWidth`. A cut never splits a
 * cluster, so each kept unit has a fixed width and the fit grows monotonically with the head.
 */
function longestFittingHead(
  text: string,
  render: (head: string) => string,
  maxWidth: number,
): string {
  const parts = graphemes(text);
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fitsDisplayWidth(render(parts.slice(0, mid).join('')), maxWidth)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return render(parts.slice(0, low).join(''));
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (fitsDisplayWidth(text, maxWidth)) return text;
  if (!fitsDisplayWidth(ELLIPSIS, maxWidth)) return '';
  return longestFittingHead(text, (head) => `${head}${ELLIPSIS}`, maxWidth);
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

export function fitFeedbackMessage(message: FeedbackMessageInput, width: number): string {
  const text =
    typeof message === 'string' ? message : `${message.prefix}${message.title}${message.suffix}`;
  if (!Number.isFinite(width)) return text;

  const max = Math.max(0, Math.floor(width));
  if (fitsDisplayWidth(text, max)) return text;
  if (typeof message === 'string') return truncateToDisplayWidth(message, max);

  const emptyTitle = `${message.prefix}${message.suffix}`;
  if (!fitsDisplayWidth(emptyTitle, max)) return truncateToDisplayWidth(text, max);

  const ellipsizedTitle = `${message.prefix}${ELLIPSIS}${message.suffix}`;
  if (!fitsDisplayWidth(ellipsizedTitle, max)) return emptyTitle;

  return longestFittingHead(
    message.title,
    (head) => `${message.prefix}${head}${ELLIPSIS}${message.suffix}`,
    max,
  );
}

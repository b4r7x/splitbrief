import { wrapHard } from '../../utils/wrap.js';

const ELLIPSIS = '\u2026';

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

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (fitsDisplayWidth(text, maxWidth)) return text;
  if (!fitsDisplayWidth(ELLIPSIS, maxWidth)) return '';

  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join('')}${ELLIPSIS}`;
    if (fitsDisplayWidth(candidate, maxWidth)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${chars.slice(0, low).join('')}${ELLIPSIS}`;
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

  const chars = Array.from(message.title);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${message.prefix}${chars.slice(0, mid).join('')}${ELLIPSIS}${
      message.suffix
    }`;
    if (fitsDisplayWidth(candidate, max)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${message.prefix}${chars.slice(0, low).join('')}${ELLIPSIS}${message.suffix}`;
}

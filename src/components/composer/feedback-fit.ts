import { SOFT_SEP } from '../../core/separators.js';
import {
  ELLIPSIS,
  elidePathMiddle,
  getTerminalCellWidth,
  graphemes,
} from '../../utils/display-text.js';
import { widestPathAwareUnit, wrapPathAware } from '../../utils/wrap.js';

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

// A separator stays on the row of the text before it: the space in front of it never breaks.
const GLUED_SEPARATOR = '\u00a0·';

function glueSeparators(text: string): string {
  return text.replaceAll(' ·', GLUED_SEPARATOR);
}

function wrapFeedback(text: string, width: number): string {
  return wrapPathAware(glueSeparators(text), width).replaceAll(GLUED_SEPARATOR, ' ·');
}

function fitsBox(text: string, box: FeedbackBox): boolean {
  if (box.maxWidth <= 0) return text.length === 0;
  return wrapFeedback(text, box.maxWidth).split('\n').length <= box.maxRows;
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

// A part with `/` and no space is a path. Each path, left to right, takes the most room the text
// before it leaves (less one cell for the end cut when text follows it), shortened from the middle
// so its file name stays. A path whose `…/<name>` does not fit there ends the message on the whole
// parts before it and ` …`, or stays whole for the end cut when they do not fit; a path that opens
// the message keeps what fits of its name. A message cut after a shortened path ends on its last
// whole part and ` …`, or on the path when ` …` does not fit.
function shortenPaths(text: string, box: FeedbackBox): string {
  const parts = text.split(SOFT_SEP);
  let shortened = -1;
  for (const [index, path] of parts.entries()) {
    if (!path.includes('/') || /\s/u.test(path)) continue;
    const before = parts
      .slice(0, index)
      .map((part) => `${part}${SOFT_SEP}`)
      .join('');
    const after = index < parts.length - 1 ? ELLIPSIS : '';
    let low = 0;
    let high = getTerminalCellWidth(path);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fitsBox(`${before}${elidePathMiddle(path, mid)}${after}`, box)) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    const name = `${ELLIPSIS}/${path.slice(path.lastIndexOf('/') + 1)}`;
    if (low >= getTerminalCellWidth(name) || (index === 0 && low > 0)) {
      parts[index] = elidePathMiddle(path, low);
      if (parts[index] !== path) shortened = index;
    } else if (index > 0) {
      const head = `${parts.slice(0, index).join(SOFT_SEP)} ${ELLIPSIS}`;
      if (fitsBox(head, box)) return head;
    }
  }
  const joined = parts.join(SOFT_SEP);
  if (shortened < 0 || fitsBox(joined, box)) return joined;
  for (let kept = parts.length - 1; kept > shortened; kept--) {
    const head = `${parts.slice(0, kept).join(SOFT_SEP)} ${ELLIPSIS}`;
    if (fitsBox(head, box)) return head;
  }
  return parts.slice(0, shortened + 1).join(SOFT_SEP);
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
  if (typeof message === 'string') return truncateToBox(shortenPaths(message, box), box);

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
 * message takes the narrowest width that keeps its row count, so its rows come out even, and never
 * cuts a word to get there.
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
  const rowCount = wrapFeedback(fitted, max).split('\n').length;
  if (rowCount === 1) return fitted;

  let low = widestPathAwareUnit(glueSeparators(fitted), max);
  let high = max;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fitsBox(fitted, { maxWidth: mid, maxRows: rowCount })) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return wrapFeedback(fitted, low)
    .split('\n')
    .map((row) => row.trim())
    .join('\n');
}

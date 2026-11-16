import { SOFT_SEP } from '../../core/separators.js';
import {
  elidePathMiddle,
  truncateTerminalDisplayTextMiddle,
  truncateTerminalDisplayTextMiddleAtWords,
} from '../../utils/display-text/truncate.js';
import { ELLIPSIS } from '../../utils/display-text/truncate.js';
import { graphemes } from '../../utils/display-text/width.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { widestPathAwareUnit, wrapPathAware } from '../../utils/display-text/wrap.js';

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

  const words = text.split(' ');
  if (words.length > 1) {
    for (const [i, word] of [...words.entries()].reverse()) {
      if (word === '' || word.endsWith('·')) continue;
      const head = words.slice(0, i + 1).join(' ');
      const candidate = `${head} ${ELLIPSIS}`;
      if (fitsBox(candidate, box)) return candidate;
    }
  }

  return longestFittingHead(text, (head) => `${head}${ELLIPSIS}`, box);
}

// A part with `/` and no space is a path. Each path, left to right, takes the most room the text
// before it leaves (less one cell for the end cut when text follows it), shortened from the middle
// so its file name stays. When `…/<name>` cannot follow the full cause, the code shortens the cause
// before it in the middle at whole words; a path that opens the message keeps what fits of its name.
// A message cut after a path, whole or shortened, ends on its last whole part and ` …`, or on the
// path when ` …` does not fit.
function shortenPaths(text: string, box: FeedbackBox): string {
  const parts = text.split(SOFT_SEP);
  let lastPath = -1;
  for (const [index, path] of parts.entries()) {
    if (!path.includes('/') || /\s/u.test(path)) continue;
    const cause = index > 0 ? parts[index - 1] : undefined;
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
      lastPath = index;
    } else if (cause !== undefined) {
      const beforePrefix = parts
        .slice(0, index - 1)
        .map((part) => `${part}${SOFT_SEP}`)
        .join('');
      const causeAfter = `${SOFT_SEP}${name}${index < parts.length - 1 ? ` ${ELLIPSIS}` : ''}`;
      let causeLow = 0;
      let causeHigh = getTerminalCellWidth(cause);
      while (causeLow < causeHigh) {
        const mid = Math.ceil((causeLow + causeHigh) / 2);
        if (
          fitsBox(
            `${beforePrefix}${truncateTerminalDisplayTextMiddleAtWords(cause, mid)}${causeAfter}`,
            box,
          )
        ) {
          causeLow = mid;
        } else {
          causeHigh = mid - 1;
        }
      }
      parts[index - 1] = truncateTerminalDisplayTextMiddleAtWords(cause, causeLow);
      parts[index] = name;
      lastPath = index;
    }
  }
  const joined = parts.join(SOFT_SEP);
  if (lastPath < 0 || fitsBox(joined, box)) return joined;
  for (let kept = parts.length - 1; kept > lastPath; kept--) {
    const head = `${parts.slice(0, kept).join(SOFT_SEP)} ${ELLIPSIS}`;
    if (fitsBox(head, box)) return head;
  }
  return parts.slice(0, lastPath + 1).join(SOFT_SEP);
}

// A name cut to fewer cells no longer tells which folder or file it is, so a message that needs a
// shorter name is cut at its end instead.
const MIN_CUT_NAME_CELLS = 16;

// A path inside a sentence (a part that opens with a word, not a path; a URL is no path) gives way
// before the message is cut: each one, left to right, is shortened from the middle only as far as
// the whole message needs to fit, down to `…/<name>`, so the words after it stay whole. A path with
// words after it in its part then cuts its name in the middle, down to `MIN_CUT_NAME_CELLS`, unless
// a later path makes the message fit at `…/<name>`: that path gives way first. A path that cannot
// make the message fit stays whole, and the message is cut at its end.
function shortenSentencePaths(text: string, box: FeedbackBox): string {
  const lead = `${ELLIPSIS}/`;
  const leadWidth = getTerminalCellWidth(lead);
  const parts = text.split(SOFT_SEP);
  const isSentence = (part: string) => part.includes(' ') && !/^\S*\//u.test(part);
  const isPath = (word: string) => word.includes('/') && !word.includes('://');
  const nameFloorOf = (path: string) =>
    leadWidth + getTerminalCellWidth(path.slice(path.lastIndexOf('/') + 1));
  for (const [partIndex, part] of parts.entries()) {
    if (!isSentence(part)) continue;
    const words = part.split(' ');
    for (const [index, path] of words.entries()) {
      if (!isPath(path)) continue;
      const name = path.slice(path.lastIndexOf('/') + 1);
      const nameFloor = nameFloorOf(path);
      const laterFoldersFit = (): boolean => {
        const current = parts.with(partIndex, words.join(' '));
        for (let p = partIndex; p < current.length; p++) {
          const sentence = current[p] ?? '';
          if (!isSentence(sentence)) continue;
          const laterWords = sentence.split(' ');
          for (let w = p === partIndex ? index + 1 : 0; w < laterWords.length; w++) {
            const later = laterWords[w] ?? '';
            if (!isPath(later)) continue;
            const floor = nameFloorOf(later);
            if (floor >= getTerminalCellWidth(later)) continue;
            const shortened = laterWords.with(w, elidePathMiddle(later, floor)).join(' ');
            if (fitsBox(current.with(p, shortened).join(SOFT_SEP), box)) return true;
          }
        }
        return false;
      };
      const shortPath = (width: number) =>
        width >= nameFloor
          ? elidePathMiddle(path, width)
          : `${lead}${truncateTerminalDisplayTextMiddle(name, width - leadWidth)}`;
      const render = (width: number) =>
        parts.with(partIndex, words.with(index, shortPath(width)).join(' ')).join(SOFT_SEP);
      let low =
        index < words.length - 1 && !laterFoldersFit()
          ? Math.min(nameFloor, leadWidth + MIN_CUT_NAME_CELLS)
          : nameFloor;
      let high = getTerminalCellWidth(path);
      if (low >= high || !fitsBox(render(low), box)) continue;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fitsBox(render(mid), box)) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      words[index] = shortPath(low);
    }
    parts[partIndex] = words.join(' ');
  }
  return parts.join(SOFT_SEP);
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
  if (typeof message === 'string')
    return truncateToBox(shortenPaths(shortenSentencePaths(message, box), box), box);

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

import {
  getTerminalCellWidth,
  wrapTerminalGraphemes,
  splitTerminalGraphemes,
} from '../../display-text/width.js';
import { assertNever } from '../../type-guards.js';
import type {
  MarkdownLayoutSegment,
  MarkdownTableAlignment,
  MarkdownLayoutLine,
} from '../types.js';
import { appendSegment, measureSegments, trimTrailingSpace } from './segments.js';

// Where a token too wide for its column may break before the layout resorts to cutting
// graphemes. The break lands after the punctuation, so the reader keeps the boundary that
// separates the two halves instead of finding a path sliced mid-segment.
const CELL_BREAK_RUN = /[^/\-_.]*[/\-_.]+|[^/\-_.]+/g;

// A cell wraps on words like every other block. A token wider than its column breaks at its
// punctuation first, and only a run with no punctuation left in it falls through to the
// grapheme split, because by then there is nowhere else for it to break.
export function wrapCellSegments(
  segments: readonly MarkdownLayoutSegment[],
  maxWidth: number,
): MarkdownLayoutSegment[][] {
  const lines: MarkdownLayoutSegment[][] = [[]];
  let lineWidth = 0;

  const appendPart = (segment: MarkdownLayoutSegment, text: string) => {
    const line = lines[lines.length - 1];
    if (line === undefined) return;
    appendSegment(line, { ...segment, text });
    lineWidth += getTerminalCellWidth(text);
  };

  const appendRun = (segment: MarkdownLayoutSegment, run: string) => {
    const runWidth = getTerminalCellWidth(run);
    if (lineWidth > 0 && lineWidth + runWidth > maxWidth) {
      lines.push([]);
      lineWidth = 0;
    }
    if (runWidth <= maxWidth) {
      appendPart(segment, run);
      return;
    }
    wrapTerminalGraphemes({
      graphemes: splitTerminalGraphemes(run),
      maxWidth,
      initialWidth: lineWidth,
      flush: () => {
        lines.push([]);
        lineWidth = 0;
        return 0;
      },
      append: (grapheme) => appendPart(segment, grapheme),
    });
  };

  for (const segment of segments) {
    for (const part of segment.text.split(/(\s+)/)) {
      if (part.length === 0) continue;
      const partWidth = getTerminalCellWidth(part);

      if (/^\s+$/.test(part)) {
        if (lineWidth === 0) continue;
        if (lineWidth + partWidth > maxWidth) {
          lines.push([]);
          lineWidth = 0;
          continue;
        }
        appendPart(segment, part);
        continue;
      }

      if (partWidth > maxWidth) {
        for (const run of part.match(CELL_BREAK_RUN) ?? [part]) {
          appendRun(segment, run);
        }
        continue;
      }

      if (lineWidth > 0 && lineWidth + partWidth > maxWidth) {
        lines.push([]);
        lineWidth = 0;
      }
      appendPart(segment, part);
    }
  }

  return lines;
}

function hardWrapSegments(
  segments: readonly MarkdownLayoutSegment[],
  maxWidth: number,
): MarkdownLayoutSegment[][] {
  const lines: MarkdownLayoutSegment[][] = [[]];
  let lineWidth = 0;

  for (const segment of segments) {
    wrapTerminalGraphemes({
      graphemes: splitTerminalGraphemes(segment.text),
      maxWidth,
      initialWidth: lineWidth,
      flush: () => {
        lines.push([]);
        lineWidth = 0;
        return 0;
      },
      append: (grapheme) => {
        const line = lines[lines.length - 1];
        if (line === undefined) return;
        appendSegment(line, { ...segment, text: grapheme });
        lineWidth += getTerminalCellWidth(grapheme);
      },
    });
  }

  return lines;
}

export function padCellLine(
  segments: readonly MarkdownLayoutSegment[],
  columnWidth: number,
  alignment: MarkdownTableAlignment,
): MarkdownLayoutSegment[] {
  const pad = Math.max(0, columnWidth - measureSegments(segments));
  if (pad === 0) return [...segments];

  switch (alignment) {
    case 'left':
      return [...segments, paddingSegment(pad)];
    case 'right':
      return [paddingSegment(pad), ...segments];
    case 'center': {
      const left = Math.floor(pad / 2);
      const right = pad - left;
      return left > 0
        ? [paddingSegment(left), ...segments, paddingSegment(right)]
        : [...segments, paddingSegment(right)];
    }
    default:
      return assertNever(alignment);
  }
}

function paddingSegment(width: number): MarkdownLayoutSegment {
  return { kind: 'tableBorder', text: ' '.repeat(width) };
}

export function clampLineToWidth(
  segments: MarkdownLayoutSegment[],
  width: number,
): MarkdownLayoutLine[] {
  if (measureSegments(segments) <= width) return [{ segments }];
  return hardWrapSegments(segments, width).map((lineSegments) => ({
    segments: trimTrailingSpace(lineSegments),
  }));
}

import wrapAnsi from 'wrap-ansi';
import { getTerminalCellWidth, splitTerminalGraphemes } from './display-text.js';

export function wrapHard(text: string, width: number): string {
  return wrapAnsi(text, width, { trim: false, hard: true });
}

const PATH_SEGMENT = /[^/]*\/|[^/]+/gu;

/**
 * The widest run `wrapPathAware` keeps whole at `width`: a word that fits, else a path segment of it
 * that fits. A box narrower than this run cuts it.
 */
export function widestPathAwareUnit(text: string, width: number): number {
  const maxCells = Math.max(1, width);
  const units = text
    .split(/[ \n]/u)
    .flatMap((word) =>
      getTerminalCellWidth(word) <= maxCells
        ? [word]
        : Array.from(word.matchAll(PATH_SEGMENT), ([segment]) => segment),
    );
  return Math.max(0, ...units.map(getTerminalCellWidth).filter((cells) => cells <= maxCells));
}

export function wrapPathAware(text: string, width: number): string {
  const maxCells = Math.max(1, width);
  const lines: string[] = [];

  for (const source of text.split('\n')) {
    let current: string[] = [];
    let currentWidth = 0;

    const flush = (): void => {
      lines.push(current.join(''));
      current = [];
      currentWidth = 0;
    };

    const append = (grapheme: string): void => {
      current.push(grapheme);
      currentWidth += getTerminalCellWidth(grapheme);
    };

    const place = (chunk: string): void => {
      const chunkWidth = getTerminalCellWidth(chunk);
      if (chunkWidth <= maxCells) {
        if (currentWidth > 0 && currentWidth + chunkWidth > maxCells) flush();
        for (const grapheme of splitTerminalGraphemes(chunk)) append(grapheme);
        return;
      }

      for (const grapheme of splitTerminalGraphemes(chunk)) {
        const graphemeWidth = getTerminalCellWidth(grapheme);
        if (currentWidth > 0 && currentWidth + graphemeWidth > maxCells) flush();
        append(grapheme);
      }
    };

    source.split(' ').forEach((word, index) => {
      const separator = index === 0 ? '' : ' ';
      const separatorWidth = getTerminalCellWidth(separator);
      const wordWidth = getTerminalCellWidth(word);
      if (currentWidth + separatorWidth + wordWidth <= maxCells) {
        place(separator);
        place(word);
        return;
      }

      if (currentWidth > 0) flush();
      if (wordWidth <= maxCells) {
        place(word);
        return;
      }
      for (const [segment] of word.matchAll(PATH_SEGMENT)) place(segment);
    });

    lines.push(current.join(''));
  }

  return lines.join('\n');
}

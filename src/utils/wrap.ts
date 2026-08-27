import wrapAnsi from 'wrap-ansi';
import { getTerminalCellWidth, splitTerminalGraphemes } from './display-text.js';

export function wrapHard(text: string, width: number): string {
  return wrapAnsi(text, width, { trim: false, hard: true });
}

const PATH_SEGMENT = /[^/]*\/|[^/]+/gu;

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

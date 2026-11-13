import type { IBuffer, IBufferCell } from '@xterm/headless';

/** A cell's foreground, with the mode it was painted in, so two reads compare like with like. */
export type TerminalForeground =
  | { readonly mode: 'default' }
  | { readonly mode: 'palette'; readonly color: number }
  | { readonly mode: 'rgb'; readonly color: string };

function foregroundOf(cell: IBufferCell): TerminalForeground {
  if (cell.isFgDefault()) return { mode: 'default' };
  if (cell.isFgPalette()) return { mode: 'palette', color: cell.getFgColor() };
  if (cell.isFgRGB()) {
    const value = cell.getFgColor() & 0xffffff;
    return { mode: 'rgb', color: `#${value.toString(16).padStart(6, '0')}` };
  }
  throw new Error('The terminal cell reports an unsupported foreground mode');
}

/**
 * The foreground of the cell `offset` characters into the first `phrase` on the visible screen.
 * The column is taken from the cells themselves, so a wide glyph before the phrase cannot shift
 * it. A screen that does not show the phrase, or a cell the row does not hold, throws instead of
 * leaving a missing value to compare.
 */
export function readForegroundAtText(
  buffer: IBuffer,
  phrase: string,
  offset = 0,
): TerminalForeground {
  if (phrase === '') throw new Error('A foreground read needs a phrase to find');
  if (offset < 0 || offset >= phrase.length) {
    throw new Error(`The offset ${offset} is outside "${phrase}"`);
  }
  for (let row = buffer.viewportY; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (line === undefined) continue;
    const cells: { column: number; text: string }[] = [];
    for (let column = 0; column < line.length; column += 1) {
      const cell = line.getCell(column);
      if (cell === undefined) break;
      if (cell.getWidth() === 0) continue;
      cells.push({ column, text: cell.getChars() || ' ' });
    }
    const text = cells.map((entry) => entry.text).join('');
    const at = text.indexOf(phrase);
    if (at < 0) continue;
    const target = at + offset;
    let position = 0;
    for (const entry of cells) {
      if (position + entry.text.length > target) {
        const cell = line.getCell(entry.column);
        if (cell === undefined) break;
        return foregroundOf(cell);
      }
      position += entry.text.length;
    }
    throw new Error(`The screen shows "${phrase}" without the cell at offset ${offset}`);
  }
  throw new Error(`The screen does not show "${phrase}"`);
}

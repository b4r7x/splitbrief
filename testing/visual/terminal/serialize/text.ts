import { CellGridSchema, type Cell, type CellGrid } from '../../contracts/cells.js';

export const SERIALIZED_LINE_ENDING = '\n';

export function serializeTxt(grid: CellGrid): string {
  return txtFromGrid(CellGridSchema.parse(grid));
}

export function txtFromGrid(grid: CellGrid): string {
  const text = `${grid.cells.map(textFromRow).join(SERIALIZED_LINE_ENDING)}${SERIALIZED_LINE_ENDING}`;
  if (hasUnsafeTxtControl(text)) {
    throw new Error('TXT serialization produced a terminal control byte');
  }
  return text;
}

function hasUnsafeTxtControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code <= 0x09 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function textFromRow(row: readonly Cell[]): string {
  return row.map((cell) => cell.grapheme).join('');
}

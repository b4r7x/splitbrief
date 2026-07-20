import type { IBuffer, IBufferCell } from '@xterm/headless';
import type { FrameArtifactIdentity } from '../contracts/artifact-identity.js';
import {
  CellGridSchema,
  type Cell,
  type CellGrid,
  type CellStyle,
  type TerminalColor,
} from '../contracts/cells.js';
import type { Hyperlink } from '../contracts/hyperlinks.js';
import { CELL_GRID_SCHEMA_VERSION } from '../contracts/schema-versions.js';

const DEFAULT_COLOR: TerminalColor = { kind: 'default' };
const DEFAULT_STYLE: CellStyle = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
};

export interface ProjectTerminalBufferOptions {
  readonly buffer: IBuffer;
  readonly identity: FrameArtifactIdentity;
  readonly hyperlinkAt: (options: {
    readonly buffer: 'normal' | 'alternate';
    readonly absoluteRow: number;
    readonly column: number;
  }) => Hyperlink | null;
}

export function projectTerminalBuffer(options: ProjectTerminalBufferOptions): CellGrid {
  const { buffer, identity, hyperlinkAt } = options;
  const { cols, rows } = identity.provenance.viewport;
  const cells: Cell[][] = [];

  for (let row = 0; row < rows; row += 1) {
    const absoluteRow = buffer.viewportY + row;
    const sourceLine = buffer.getLine(absoluteRow);
    const projectedRow: Cell[] = [];
    for (let column = 0; column < cols; column += 1) {
      const sourceCell = sourceLine?.getCell(column);
      const previous = projectedRow[column - 1];
      projectedRow.push(
        sourceCell === undefined
          ? blankCell()
          : projectCell({
              sourceCell,
              previous,
              hyperlink: hyperlinkAt({ buffer: buffer.type, absoluteRow, column }),
            }),
      );
    }
    cells.push(projectedRow);
  }

  return CellGridSchema.parse({
    schemaVersion: CELL_GRID_SCHEMA_VERSION,
    identity,
    rect: { x: 0, y: 0, width: cols, height: rows },
    cells,
  });
}

function projectCell(options: {
  readonly sourceCell: IBufferCell;
  readonly previous: Cell | undefined;
  readonly hyperlink: Hyperlink | null;
}): Cell {
  const { sourceCell, previous, hyperlink } = options;
  const width = sourceCell.getWidth();
  if (width === 0) {
    if (previous === undefined || previous.continuation || previous.width !== 2) {
      throw new Error('Terminal emitted a continuation without a preceding wide cell');
    }
    return {
      grapheme: '',
      width: 0,
      continuation: true,
      foreground: previous.foreground,
      background: previous.background,
      style: previous.style,
      hyperlink: previous.hyperlink,
    };
  }
  if (width !== 1 && width !== 2) {
    throw new Error('Terminal emitted an unsupported cell width');
  }

  const grapheme = sourceCell.getChars() || ' ';
  return {
    grapheme,
    width,
    continuation: false,
    foreground: foregroundColor(sourceCell),
    background: backgroundColor(sourceCell),
    style: cellStyle(sourceCell),
    hyperlink,
  };
}

function blankCell(): Cell {
  return {
    grapheme: ' ',
    width: 1,
    continuation: false,
    foreground: DEFAULT_COLOR,
    background: DEFAULT_COLOR,
    style: DEFAULT_STYLE,
    hyperlink: null,
  };
}

function foregroundColor(cell: IBufferCell): TerminalColor {
  if (cell.isFgDefault()) return DEFAULT_COLOR;
  if (cell.isFgPalette()) return { kind: 'indexed', index: cell.getFgColor() };
  if (cell.isFgRGB()) return rgbColor(cell.getFgColor());
  throw new Error('Terminal emitted an unsupported foreground color mode');
}

function backgroundColor(cell: IBufferCell): TerminalColor {
  if (cell.isBgDefault()) return DEFAULT_COLOR;
  if (cell.isBgPalette()) return { kind: 'indexed', index: cell.getBgColor() };
  if (cell.isBgRGB()) return rgbColor(cell.getBgColor());
  throw new Error('Terminal emitted an unsupported background color mode');
}

function rgbColor(value: number): TerminalColor {
  return {
    kind: 'rgb',
    red: (value >> 16) & 0xff,
    green: (value >> 8) & 0xff,
    blue: value & 0xff,
  };
}

function cellStyle(cell: IBufferCell): CellStyle {
  return {
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    blink: cell.isBlink() !== 0,
    inverse: cell.isInverse() !== 0,
    invisible: cell.isInvisible() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
  };
}

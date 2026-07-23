import { CellGridSchema, type CellGrid } from '../../contracts/cells.js';
import { ansiFromGrid } from './ansi.js';
import { cellsJsonFromGrid } from './cells-json.js';
import { txtFromGrid } from './text.js';

export interface SerializedTerminalTruth {
  readonly ansi: string;
  readonly txt: string;
  readonly cellsJson: string;
}

export function serializeTerminalTruth(grid: CellGrid): SerializedTerminalTruth {
  const validated = CellGridSchema.parse(grid);
  return {
    ansi: ansiFromGrid(validated),
    txt: txtFromGrid(validated),
    cellsJson: cellsJsonFromGrid(validated),
  };
}

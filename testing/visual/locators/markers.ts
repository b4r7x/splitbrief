import { splitTerminalGraphemes } from '../../../src/utils/display-text.js';
import {
  CellGridSchema,
  isCellRectOnGraphemeBoundaries,
  type CellGrid,
} from '../contracts/cells.js';
import { CellRectSchema, type CellRect } from '../contracts/geometry.js';
import {
  LOCATOR_FAILURE_CODE,
  type LocatorFailureCode,
  type ResolveMarkerRectOptions,
} from './types.js';

export function resolveMarkerRect(options: ResolveMarkerRectOptions): CellRect {
  const grid = parseGrid(options.grid);
  const bounds = clipCellRect(options.bounds, grid.rect);
  const graphemes = splitTerminalGraphemes(options.marker);
  if (graphemes.length === 0 || graphemes.join('') !== options.marker) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidContext,
      'Marker must be non-empty terminal text',
    );
  }

  const matches = findMarkerMatches({ grid, bounds, graphemes });
  if (options.selection.kind === 'unique') {
    if (matches.length === 0) {
      throw locatorError(
        LOCATOR_FAILURE_CODE.notFound,
        'Marker has no match in its bounded region',
      );
    }
    if (matches.length > 1) {
      throw locatorError(
        LOCATOR_FAILURE_CODE.ambiguous,
        `Marker has ${matches.length} matches in its bounded region`,
      );
    }
    const match = matches[0];
    if (!match) throw locatorError(LOCATOR_FAILURE_CODE.notFound, 'Marker match is unavailable');
    return match;
  }

  if (!Number.isInteger(options.selection.index) || options.selection.index < 0) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Explicit marker index must be a non-negative integer',
    );
  }
  const match = matches[options.selection.index];
  if (!match) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.notFound,
      `Marker index ${options.selection.index} is outside ${matches.length} matches`,
    );
  }
  return match;
}

export function clipCellRect(rect: CellRect, bounds: CellRect): CellRect {
  const parsedRect = CellRectSchema.safeParse(rect);
  const parsedBounds = CellRectSchema.safeParse(bounds);
  if (!parsedRect.success || !parsedBounds.success) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Locator and frame rectangles require non-negative origins and positive dimensions',
    );
  }

  const x = Math.max(parsedRect.data.x, parsedBounds.data.x);
  const y = Math.max(parsedRect.data.y, parsedBounds.data.y);
  const right = Math.min(
    parsedRect.data.x + parsedRect.data.width,
    parsedBounds.data.x + parsedBounds.data.width,
  );
  const bottom = Math.min(
    parsedRect.data.y + parsedRect.data.height,
    parsedBounds.data.y + parsedBounds.data.height,
  );
  if (right <= x || bottom <= y) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Locator rectangle does not intersect its source frame',
    );
  }
  return CellRectSchema.parse({ x, y, width: right - x, height: bottom - y });
}

export function fitRectToGraphemeBoundaries(grid: CellGrid, rect: CellRect): CellRect {
  let x = rect.x;
  let right = rect.x + rect.width;
  const firstRow = rect.y - grid.rect.y;
  const lastRow = firstRow + rect.height;
  const rows = grid.cells.slice(firstRow, lastRow);

  while (x < right && rows.some((row) => row[x]?.continuation)) {
    x += 1;
  }
  while (
    right > x &&
    rows.some((row) => {
      const cell = row[right - 1];
      return cell !== undefined && !cell.continuation && cell.width === 2;
    })
  ) {
    right -= 1;
  }

  if (right <= x) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Locator rectangle cannot be aligned to terminal grapheme boundaries',
    );
  }
  const aligned = CellRectSchema.parse({ ...rect, x, width: right - x });
  if (!isCellRectOnGraphemeBoundaries(grid.cells, aligned)) {
    throw locatorError(
      LOCATOR_FAILURE_CODE.invalidGeometry,
      'Locator rectangle splits a terminal grapheme',
    );
  }
  return aligned;
}

function findMarkerMatches(options: {
  readonly grid: CellGrid;
  readonly bounds: CellRect;
  readonly graphemes: readonly string[];
}): CellRect[] {
  const matches: CellRect[] = [];
  const maxY = options.bounds.y + options.bounds.height;
  const maxX = options.bounds.x + options.bounds.width;
  for (let y = options.bounds.y; y < maxY; y += 1) {
    for (let x = options.bounds.x; x < maxX; x += 1) {
      const width = markerWidthAt({ ...options, x, y, maxX });
      if (width !== null) matches.push(CellRectSchema.parse({ x, y, width, height: 1 }));
    }
  }
  return matches;
}

function markerWidthAt(options: {
  readonly grid: CellGrid;
  readonly graphemes: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly maxX: number;
}): number | null {
  const row = options.grid.cells[options.y - options.grid.rect.y];
  if (!row) return null;
  let column = options.x;
  for (const grapheme of options.graphemes) {
    if (column >= options.maxX) return null;
    const cell = row[column - options.grid.rect.x];
    if (!cell || cell.continuation || cell.grapheme !== grapheme) return null;
    column += cell.width;
  }
  return column - options.x;
}

function parseGrid(value: CellGrid): CellGrid {
  const parsed = CellGridSchema.safeParse(value);
  if (!parsed.success) {
    throw locatorError(LOCATOR_FAILURE_CODE.invalidFrame, 'Cell grid is invalid');
  }
  return parsed.data;
}

function locatorError(code: LocatorFailureCode, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

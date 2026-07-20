import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ArtifactIdentitySchema } from './artifact-identity.js';
import {
  CellRectSchema,
  isCellRectInViewport,
  isFullFrameRect,
  type CellRect,
} from './geometry.js';
import { HyperlinkSchema, type Hyperlink } from './hyperlinks.js';
import { MAX_VIEWPORT_COLS, MAX_VIEWPORT_ROWS } from './limits.js';
import { isSafePersistedTerminalText, isSafeTerminalGrapheme } from './persisted-data.js';
import { CELL_GRID_SCHEMA_VERSION } from './schema-versions.js';

export const TerminalColorSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('default') }).strict(),
    z.object({ kind: z.literal('indexed'), index: z.number().int().min(0).max(255) }).strict(),
    z
      .object({
        kind: z.literal('rgb'),
        red: z.number().int().min(0).max(255),
        green: z.number().int().min(0).max(255),
        blue: z.number().int().min(0).max(255),
      })
      .strict(),
  ])
  .readonly();
export type TerminalColor = z.infer<typeof TerminalColorSchema>;

export const CellStyleSchema = z
  .object({
    bold: z.boolean(),
    dim: z.boolean(),
    italic: z.boolean(),
    underline: z.boolean(),
    blink: z.boolean(),
    inverse: z.boolean(),
    invisible: z.boolean(),
    strikethrough: z.boolean(),
  })
  .strict()
  .readonly();
export type CellStyle = z.infer<typeof CellStyleSchema>;

const CellBaseShape = {
  foreground: TerminalColorSchema,
  background: TerminalColorSchema,
  style: CellStyleSchema,
  hyperlink: HyperlinkSchema.nullable(),
};

export const CellSchema = z
  .discriminatedUnion('continuation', [
    z
      .object({
        ...CellBaseShape,
        grapheme: z.string().refine(isSafeTerminalGrapheme, {
          message: 'cell must contain exactly one safe visible grapheme cluster',
        }),
        width: z.union([z.literal(1), z.literal(2)]),
        continuation: z.literal(false),
      })
      .strict(),
    z
      .object({
        ...CellBaseShape,
        grapheme: z.literal(''),
        width: z.literal(0),
        continuation: z.literal(true),
      })
      .strict(),
  ])
  .readonly();
export type Cell = z.infer<typeof CellSchema>;

export const CellGridSchema = z
  .object({
    schemaVersion: z.literal(CELL_GRID_SCHEMA_VERSION),
    identity: ArtifactIdentitySchema,
    rect: CellRectSchema,
    cells: z
      .array(z.array(CellSchema).max(MAX_VIEWPORT_COLS).readonly())
      .max(MAX_VIEWPORT_ROWS)
      .readonly(),
  })
  .strict()
  .superRefine((grid, context) => {
    const viewport = grid.identity.provenance.viewport;
    if (!isCellRectInViewport(grid.rect, viewport)) {
      context.addIssue({
        code: 'custom',
        message: 'cell rectangle exceeds its viewport',
        path: ['rect'],
      });
    }
    if (grid.identity.kind === 'frame' && !isFullFrameRect(grid.rect, viewport)) {
      context.addIssue({
        code: 'custom',
        message: 'frame rectangle must fill its viewport',
        path: ['rect'],
      });
    }
    if (grid.cells.length !== grid.rect.height) {
      context.addIssue({
        code: 'custom',
        message: 'cell row count does not match rectangle height',
        path: ['cells'],
      });
    }
    for (const [row, cells] of grid.cells.entries()) {
      if (cells.length !== grid.rect.width) {
        context.addIssue({
          code: 'custom',
          message: 'cell column count does not match rectangle width',
          path: ['cells', row],
        });
      }
      addWideCellIssues({ cells, row, context });
    }

    const persistedText = grid.cells.flatMap((row) => row.map((cell) => cell.grapheme)).join('');
    if (!isSafePersistedTerminalText(persistedText)) {
      context.addIssue({
        code: 'custom',
        message: 'cell grid contains a secret, host path, or private URL',
        path: ['cells'],
      });
    }
  })
  .readonly();
export type CellGrid = z.infer<typeof CellGridSchema>;

export function isCellRectOnGraphemeBoundaries(
  sourceCells: readonly (readonly Cell[])[],
  rect: CellRect,
): boolean {
  if (rect.y + rect.height > sourceCells.length) return false;

  for (let row = rect.y; row < rect.y + rect.height; row += 1) {
    const cells = sourceCells[row];
    if (!cells || rect.x + rect.width > cells.length) return false;
    const firstCell = cells[rect.x];
    const lastCell = cells[rect.x + rect.width - 1];
    if (!firstCell || !lastCell) return false;
    if (firstCell.continuation || (!lastCell.continuation && lastCell.width === 2)) return false;
  }

  return true;
}

function addWideCellIssues(options: {
  readonly cells: readonly Cell[];
  readonly row: number;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  for (const [column, cell] of options.cells.entries()) {
    if (cell.continuation) {
      const previous = options.cells[column - 1];
      if (
        !previous ||
        previous.continuation ||
        previous.width !== 2 ||
        !hasMatchingCellMetadata({ left: previous, right: cell })
      ) {
        options.context.addIssue({
          code: 'custom',
          message: 'continuation cell must immediately follow and match a width-2 cell',
          path: ['cells', options.row, column],
        });
      }
      continue;
    }

    if (cell.width === 2 && !options.cells[column + 1]?.continuation) {
      options.context.addIssue({
        code: 'custom',
        message: 'width-2 cell must be followed by a continuation cell',
        path: ['cells', options.row, column],
      });
    }
  }
}

function hasMatchingCellMetadata(options: { readonly left: Cell; readonly right: Cell }): boolean {
  const { left, right } = options;
  return (
    hasMatchingTerminalColor({ left: left.foreground, right: right.foreground }) &&
    hasMatchingTerminalColor({ left: left.background, right: right.background }) &&
    isDeepStrictEqual(left.style, right.style) &&
    hasMatchingHyperlink({ left: left.hyperlink, right: right.hyperlink })
  );
}

function hasMatchingTerminalColor(options: {
  readonly left: TerminalColor;
  readonly right: TerminalColor;
}): boolean {
  const { left, right } = options;
  if (left.kind !== right.kind) return false;

  switch (left.kind) {
    case 'default':
      return right.kind === 'default';
    case 'indexed':
      return right.kind === 'indexed' && left.index === right.index;
    case 'rgb':
      return (
        right.kind === 'rgb' &&
        left.red === right.red &&
        left.green === right.green &&
        left.blue === right.blue
      );
    default: {
      const unhandled: never = left;
      return unhandled;
    }
  }
}

function hasMatchingHyperlink(options: {
  readonly left: Hyperlink | null;
  readonly right: Hyperlink | null;
}): boolean {
  const { left, right } = options;
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;

  switch (left.kind) {
    case 'external':
      return right.kind === 'external' && left.url === right.url;
    case 'project-file':
      return right.kind === 'project-file' && left.path === right.path;
    default: {
      const unhandled: never = left;
      return unhandled;
    }
  }
}

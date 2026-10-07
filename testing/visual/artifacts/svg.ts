import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { xterm256Hex } from '../../../src/utils/color.js';
import {
  CellGridSchema,
  type Cell,
  type CellGrid,
  type TerminalColor,
} from '../contracts/cells.js';
import {
  RendererMetadataSchema,
  type RendererMetadata,
  type TerminalProfile,
} from '../contracts/manifest-fields.js';

const DEFAULT_FOREGROUND = '#d4d4d4';
const DEFAULT_BACKGROUND = '#101010';
const ANSI_PALETTE: readonly string[] = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];
const lightPaletteFixture = z
  .object({
    light: z.array(
      z.object({
        name: z.string(),
        foreground: z.string(),
        background: z.string(),
        slots: z.array(z.string()).length(16),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../fixtures/terminal-palettes/ghostty-themes.json', import.meta.url),
        'utf8',
      ),
    ),
  )
  .light.find((palette) => palette.name === 'GitHub Light Default');
if (lightPaletteFixture === undefined) {
  throw new Error('GitHub Light Default terminal fixture is missing');
}

interface TerminalPalette {
  readonly foreground: string;
  readonly background: string;
  readonly slots: readonly string[];
}

const lightPalette: TerminalPalette = lightPaletteFixture;

const darkPalette: TerminalPalette = {
  foreground: DEFAULT_FOREGROUND,
  background: DEFAULT_BACKGROUND,
  slots: ANSI_PALETTE,
};

export const SVG_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace';
export const SVG_CELL_WIDTH_PX = 8;
export const SVG_CELL_HEIGHT_PX = 16;
export const SVG_FONT_SIZE_PX = 14;
export const SVG_BASELINE_PX = 13;

export const SVG_RENDERER_METADATA: RendererMetadata = RendererMetadataSchema.parse({
  name: 'splitbrief-cell-svg',
  version: '1.2.0',
  fontFamily: SVG_FONT_FAMILY,
  cellWidthPx: SVG_CELL_WIDTH_PX,
  cellHeightPx: SVG_CELL_HEIGHT_PX,
});

export interface SvgDimensions {
  readonly widthPx: number;
  readonly heightPx: number;
}

interface EffectiveColors {
  readonly foreground: string;
  readonly background: string;
}

export function getSvgDimensions(gridInput: CellGrid): SvgDimensions {
  const grid = CellGridSchema.parse(gridInput);
  return {
    widthPx: grid.rect.width * SVG_CELL_WIDTH_PX,
    heightPx: grid.rect.height * SVG_CELL_HEIGHT_PX,
  };
}

export function renderCellGridSvg(gridInput: CellGrid, profile: TerminalProfile): string {
  const grid = CellGridSchema.parse(gridInput);
  const { widthPx, heightPx } = getSvgDimensions(grid);
  const palette = profile === 'unicode-light' ? lightPalette : darkPalette;
  const backgrounds: string[] = [];
  const text: string[] = [];

  for (const [row, cells] of grid.cells.entries()) {
    for (const [column, cell] of cells.entries()) {
      if (cell.continuation) continue;
      const colors = effectiveColors(cell, palette);
      if (colors.background !== palette.background) {
        backgrounds.push(renderBackground({ cell, row, column, color: colors.background }));
      }
      if (cell.grapheme !== ' ' && !cell.style.invisible) {
        const options = { cell, row, column, color: colors.foreground };
        text.push(renderBlockElement(options) ?? renderText(options));
      }
    }
  }

  const metadata = escapeXmlText(
    JSON.stringify({
      renderer: SVG_RENDERER_METADATA.name,
      rendererVersion: SVG_RENDERER_METADATA.version,
      fontFamily: SVG_FONT_FAMILY,
      glyphPolicy: 'monospace-font-fallback+block-elements-as-rects',
      hyperlinkPolicy: 'non-interactive-kind-only',
    }),
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" role="img" aria-label="Terminal capture" xml:space="preserve" shape-rendering="crispEdges" data-source-kind="${grid.identity.kind}" data-cell-width="${SVG_CELL_WIDTH_PX}" data-cell-height="${SVG_CELL_HEIGHT_PX}">`,
    `  <metadata>${metadata}</metadata>`,
    `  <rect width="${widthPx}" height="${heightPx}" fill="${palette.background}"/>`,
    ...backgrounds,
    ...text,
    '</svg>',
  ];
  return `${lines.join('\n')}\n`;
}

function renderBackground(options: {
  readonly cell: Extract<Cell, { readonly continuation: false }>;
  readonly row: number;
  readonly column: number;
  readonly color: string;
}): string {
  const { cell, row, column, color } = options;
  return `  <rect x="${column * SVG_CELL_WIDTH_PX}" y="${row * SVG_CELL_HEIGHT_PX}" width="${cell.width * SVG_CELL_WIDTH_PX}" height="${SVG_CELL_HEIGHT_PX}" fill="${color}"/>`;
}

// A terminal paints the Block Elements itself, as exact fractions of the cell, so a column of them
// is one unbroken line. A font's own glyphs fall short of the row — Menlo's by a couple of pixels —
// which would show a border this product draws whole as a dashed one. The capture draws them the
// way a terminal does; anything outside the solid families (the shades, the quadrants) still goes
// through the font.
function blockElementRect(grapheme: string): readonly [number, number, number, number] | null {
  const code = grapheme.codePointAt(0) ?? 0;
  if (code === 0x2580) return [0, 0, 1, 1 / 2];
  if (code >= 0x2581 && code <= 0x2588) {
    const height = (code - 0x2580) / 8;
    return [0, 1 - height, 1, height];
  }
  if (code >= 0x2589 && code <= 0x258f) return [0, 0, (0x2590 - code) / 8, 1];
  if (code === 0x2590) return [1 / 2, 0, 1 / 2, 1];
  if (code === 0x2594) return [0, 0, 1, 1 / 8];
  if (code === 0x2595) return [7 / 8, 0, 1 / 8, 1];
  return null;
}

function renderBlockElement(options: {
  readonly cell: Extract<Cell, { readonly continuation: false }>;
  readonly row: number;
  readonly column: number;
  readonly color: string;
}): string | null {
  const { cell, row, column, color } = options;
  const fraction = blockElementRect(cell.grapheme);
  if (fraction === null) return null;
  const [x, y, width, height] = fraction;
  const cellWidth = cell.width * SVG_CELL_WIDTH_PX;
  const attributes = [
    `x="${formatPx(column * SVG_CELL_WIDTH_PX + x * cellWidth)}"`,
    `y="${formatPx((row + y) * SVG_CELL_HEIGHT_PX)}"`,
    `width="${formatPx(width * cellWidth)}"`,
    `height="${formatPx(height * SVG_CELL_HEIGHT_PX)}"`,
    `fill="${color}"`,
    ...(cell.style.dim ? ['opacity="0.65"'] : []),
    `data-row="${row}"`,
    `data-column="${column}"`,
    `data-cell-width="${cell.width}"`,
  ];
  return `  <rect ${attributes.join(' ')}/>`;
}

function formatPx(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function renderText(options: {
  readonly cell: Extract<Cell, { readonly continuation: false }>;
  readonly row: number;
  readonly column: number;
  readonly color: string;
}): string {
  const { cell, row, column, color } = options;
  const attributes = [
    `x="${column * SVG_CELL_WIDTH_PX}"`,
    `y="${row * SVG_CELL_HEIGHT_PX + SVG_BASELINE_PX}"`,
    `fill="${color}"`,
    `font-family="${escapeXmlAttribute(SVG_FONT_FAMILY)}"`,
    `font-size="${SVG_FONT_SIZE_PX}"`,
    ...(cell.style.bold ? ['font-weight="700"'] : []),
    ...(cell.style.italic ? ['font-style="italic"'] : []),
    ...(cell.style.dim ? ['opacity="0.65"'] : []),
    ...textDecorationAttributes(cell),
    ...(cell.style.blink ? ['data-blink="true"'] : []),
    ...(cell.hyperlink === null ? [] : [`data-link-kind="${cell.hyperlink.kind}"`]),
    `data-row="${row}"`,
    `data-column="${column}"`,
    `data-cell-width="${cell.width}"`,
  ];
  return `  <text ${attributes.join(' ')}>${escapeXmlText(cell.grapheme)}</text>`;
}

function textDecorationAttributes(
  cell: Extract<Cell, { readonly continuation: false }>,
): readonly string[] {
  const decorations = [
    ...(cell.style.underline ? ['underline'] : []),
    ...(cell.style.strikethrough ? ['line-through'] : []),
  ];
  return decorations.length === 0 ? [] : [`text-decoration="${decorations.join(' ')}"`];
}

function effectiveColors(
  cell: Extract<Cell, { readonly continuation: false }>,
  palette: TerminalPalette,
): EffectiveColors {
  const foreground = terminalColor(cell.foreground, palette.foreground, palette.slots);
  const background = terminalColor(cell.background, palette.background, palette.slots);
  return cell.style.inverse
    ? { foreground: background, background: foreground }
    : { foreground, background };
}

function terminalColor(
  color: TerminalColor,
  defaultColor: string,
  slots: readonly string[],
): string {
  switch (color.kind) {
    case 'default':
      return defaultColor;
    case 'indexed':
      return slots[color.index] ?? xterm256Hex(color.index);
    case 'rgb':
      return `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`;
    default: {
      const unhandled: never = color;
      return unhandled;
    }
  }
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

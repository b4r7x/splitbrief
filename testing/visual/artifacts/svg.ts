import {
  CellGridSchema,
  type Cell,
  type CellGrid,
  type TerminalColor,
} from '../contracts/cells.js';
import { RendererMetadataSchema, type RendererMetadata } from '../contracts/manifest-fields.js';

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
const COLOR_CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

export const SVG_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace';
export const SVG_CELL_WIDTH_PX = 8;
export const SVG_CELL_HEIGHT_PX = 16;
export const SVG_FONT_SIZE_PX = 14;
export const SVG_BASELINE_PX = 13;

export const SVG_RENDERER_METADATA: RendererMetadata = RendererMetadataSchema.parse({
  name: 'splitbrief-cell-svg',
  version: '1.0.0',
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

export function renderCellGridSvg(gridInput: CellGrid): string {
  const grid = CellGridSchema.parse(gridInput);
  const { widthPx, heightPx } = getSvgDimensions(grid);
  const backgrounds: string[] = [];
  const text: string[] = [];

  for (const [row, cells] of grid.cells.entries()) {
    for (const [column, cell] of cells.entries()) {
      if (cell.continuation) continue;
      const colors = effectiveColors(cell);
      if (colors.background !== DEFAULT_BACKGROUND) {
        backgrounds.push(renderBackground({ cell, row, column, color: colors.background }));
      }
      if (cell.grapheme !== ' ' && !cell.style.invisible) {
        text.push(renderText({ cell, row, column, color: colors.foreground }));
      }
    }
  }

  const metadata = escapeXmlText(
    JSON.stringify({
      renderer: SVG_RENDERER_METADATA.name,
      rendererVersion: SVG_RENDERER_METADATA.version,
      fontFamily: SVG_FONT_FAMILY,
      glyphPolicy: 'monospace-font-fallback',
      hyperlinkPolicy: 'non-interactive-kind-only',
    }),
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" role="img" aria-label="Terminal capture" xml:space="preserve" shape-rendering="crispEdges" data-source-kind="${grid.identity.kind}" data-cell-width="${SVG_CELL_WIDTH_PX}" data-cell-height="${SVG_CELL_HEIGHT_PX}">`,
    `  <metadata>${metadata}</metadata>`,
    `  <rect width="${widthPx}" height="${heightPx}" fill="${DEFAULT_BACKGROUND}"/>`,
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

function effectiveColors(cell: Extract<Cell, { readonly continuation: false }>): EffectiveColors {
  const foreground = terminalColor(cell.foreground, DEFAULT_FOREGROUND);
  const background = terminalColor(cell.background, DEFAULT_BACKGROUND);
  return cell.style.inverse
    ? { foreground: background, background: foreground }
    : { foreground, background };
}

function terminalColor(color: TerminalColor, defaultColor: string): string {
  switch (color.kind) {
    case 'default':
      return defaultColor;
    case 'indexed':
      return indexedColor(color.index);
    case 'rgb':
      return `#${hex(color.red)}${hex(color.green)}${hex(color.blue)}`;
    default: {
      const unhandled: never = color;
      return unhandled;
    }
  }
}

function indexedColor(index: number): string {
  const paletteColor = ANSI_PALETTE[index];
  if (paletteColor !== undefined) return paletteColor;
  if (index < 232) {
    const cubeIndex = index - 16;
    const red = COLOR_CUBE_LEVELS[Math.floor(cubeIndex / 36)];
    const green = COLOR_CUBE_LEVELS[Math.floor((cubeIndex % 36) / 6)];
    const blue = COLOR_CUBE_LEVELS[cubeIndex % 6];
    if (red === undefined || green === undefined || blue === undefined) {
      throw new Error('Indexed terminal color is outside the color cube');
    }
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
  }
  const level = 8 + (index - 232) * 10;
  return `#${hex(level)}${hex(level)}${hex(level)}`;
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

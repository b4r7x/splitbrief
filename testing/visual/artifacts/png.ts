import sharp from 'sharp';
import { CellGridSchema, type CellGrid } from '../contracts/cells.js';
import { FailureSchema, type Failure } from '../contracts/failures.js';
import { safeId } from '../contracts/identifiers.js';
import { RendererMetadataSchema, type RendererMetadata } from '../contracts/manifest-fields.js';
import {
  getSvgDimensions,
  renderCellGridSvg,
  SVG_CELL_HEIGHT_PX,
  SVG_CELL_WIDTH_PX,
  SVG_FONT_FAMILY,
  type SvgDimensions,
} from './svg.js';

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const MAX_PNG_BYTES = 128 * 1_024 * 1_024;
const SHARP_INPUT_PIXEL_LIMIT = 50_000_000;

const sharpVersion = sharp.versions.sharp;
if (sharpVersion === undefined) {
  throw new Error('The installed sharp package did not report its version');
}

export const PNG_RENDERER_METADATA: RendererMetadata = RendererMetadataSchema.parse({
  name: 'sharp',
  version: sharpVersion,
  fontFamily: SVG_FONT_FAMILY,
  cellWidthPx: SVG_CELL_WIDTH_PX,
  cellHeightPx: SVG_CELL_HEIGHT_PX,
});

export type PngFailure = Extract<Failure, { readonly stage: 'png' }>;

export interface PngRasterizerInput {
  readonly svg: string;
  readonly dimensions: SvgDimensions;
}

export type PngRasterizer = (input: PngRasterizerInput) => Promise<Uint8Array>;

export interface PngRenderSuccess {
  readonly kind: 'success';
  readonly bytes: Uint8Array;
  readonly dimensions: SvgDimensions;
  readonly renderer: RendererMetadata;
}

export interface PngRenderFailure {
  readonly kind: 'failure';
  readonly failure: PngFailure;
}

export type PngRenderResult = PngRenderSuccess | PngRenderFailure;

export async function renderCellGridPng(options: {
  readonly grid: CellGrid;
  readonly svg: string;
  readonly rasterize?: PngRasterizer;
}): Promise<PngRenderResult> {
  const grid = CellGridSchema.parse(options.grid);
  const dimensions = getSvgDimensions(grid);

  try {
    if (options.svg !== renderCellGridSvg(grid)) {
      throw new Error('PNG source does not match the canonical cell-grid SVG');
    }

    const rasterize = options.rasterize ?? rasterizeSvg;
    const bytes = Uint8Array.from(await rasterize({ svg: options.svg, dimensions }));
    await validatePng({ bytes, dimensions });

    return {
      kind: 'success',
      bytes,
      dimensions,
      renderer: PNG_RENDERER_METADATA,
    };
  } catch {
    return {
      kind: 'failure',
      failure: createPngFailure(grid),
    };
  }
}

async function rasterizeSvg(input: PngRasterizerInput): Promise<Uint8Array> {
  const bytes = await sharp(new TextEncoder().encode(input.svg), {
    animated: false,
    density: 72,
    failOn: 'error',
    ignoreIcc: true,
    limitInputChannels: 4,
    limitInputPixels: SHARP_INPUT_PIXEL_LIMIT,
    page: 0,
    pages: 1,
    sequentialRead: true,
    unlimited: false,
  })
    .png({
      adaptiveFiltering: false,
      compressionLevel: 9,
      force: true,
      palette: false,
      progressive: false,
    })
    .toBuffer();
  return Uint8Array.from(bytes);
}

async function validatePng(options: {
  readonly bytes: Uint8Array;
  readonly dimensions: SvgDimensions;
}): Promise<void> {
  const { bytes, dimensions } = options;
  if (
    bytes.byteLength > MAX_PNG_BYTES ||
    !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    throw new Error('Rasterizer output is not a bounded PNG');
  }

  const metadata = await sharp(bytes, {
    animated: false,
    failOn: 'error',
    limitInputChannels: 4,
    limitInputPixels: SHARP_INPUT_PIXEL_LIMIT,
    page: 0,
    pages: 1,
    sequentialRead: true,
    unlimited: false,
  }).metadata();

  if (
    metadata.format !== 'png' ||
    metadata.width !== dimensions.widthPx ||
    metadata.height !== dimensions.heightPx
  ) {
    throw new Error('Rasterizer output has an unexpected format or dimensions');
  }
}

function createPngFailure(grid: CellGrid): PngFailure {
  const failure = FailureSchema.parse({
    stage: 'png',
    code: safeId('png-raster-failed'),
    message: 'PNG rasterization failed for the selected artifact',
    artifact: grid.identity,
  });
  if (failure.stage !== 'png') {
    throw new Error('PNG failure contract produced an unexpected failure stage');
  }
  return failure;
}

import { describe, expect, it } from 'vitest';
import {
  ArtifactIdentitySchema,
  CropArtifactIdentitySchema,
  FrameArtifactIdentitySchema,
  cropAccountingKey,
  frameAccountingKey,
  frameArtifactKey,
} from './contracts/artifact-identity.js';
import { ArtifactFilesSchema, ArtifactRecordSchema } from './contracts/artifacts.js';
import {
  CellGridSchema,
  type CellGrid,
  CellSchema,
  type Cell,
  CellStyleSchema,
  type CellStyle,
  TerminalColorSchema,
  isCellRectOnGraphemeBoundaries,
} from './contracts/cells.js';
import { CellRectSchema, viewport } from './contracts/geometry.js';
import { checkpointId, elementId, relativeArtifactPath } from './contracts/identifiers.js';
import { MAX_VIEWPORT_COLS } from './contracts/limits.js';
import { isSafeTerminalGrapheme } from './contracts/persisted-data.js';
import { CELL_GRID_SCHEMA_VERSION } from './contracts/schema-versions.js';
import {
  ArtifactProvenanceSchema,
  CaptureRequestSchema,
  type CaptureRequest,
  CaptureSelectionSchema,
  CaptureTargetSchema,
  type CaptureTarget,
  captureAccountingKey,
  hasMatchingProvenance,
} from './contracts/selection.js';
import {
  createCropArtifact,
  createCropIdentity,
  createFrameArtifact,
  createFrameIdentity,
  createVisualProvenance,
} from './visual-contract-fixtures.js';

const DEFAULT_STYLE: CellStyle = CellStyleSchema.parse({
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
});
const DEFAULT_COLOR = TerminalColorSchema.parse({ kind: 'default' });

function makeCell(grapheme: string, width: 1 | 2 = 1): Cell {
  return CellSchema.parse({
    grapheme,
    width,
    continuation: false,
    foreground: DEFAULT_COLOR,
    background: DEFAULT_COLOR,
    style: DEFAULT_STYLE,
    hyperlink: null,
  });
}

function makeContinuationCell(): Cell {
  return CellSchema.parse({
    grapheme: '',
    width: 0,
    continuation: true,
    foreground: DEFAULT_COLOR,
    background: DEFAULT_COLOR,
    style: DEFAULT_STYLE,
    hyperlink: null,
  });
}

function makeTextGrid(text: string) {
  const gridViewport = viewport({ cols: text.length, rows: 1 });
  return {
    schemaVersion: CELL_GRID_SCHEMA_VERSION,
    identity: createFrameIdentity(createVisualProvenance(gridViewport)),
    rect: { x: 0, y: 0, width: gridViewport.cols, height: gridViewport.rows },
    cells: [[...text].map((grapheme) => makeCell(grapheme))],
  };
}

describe('visual cell and artifact contracts', () => {
  it('requires selected targets to match explicit requests and preserve capture identity', () => {
    const provenance = createVisualProvenance();
    const request: CaptureRequest = CaptureRequestSchema.parse({
      provenance,
      elementIds: [elementId('hero')],
    });
    const target: CaptureTarget = CaptureTargetSchema.parse({
      provenance,
      elementIds: [elementId('hero')],
    });
    const selection = CaptureSelectionSchema.parse({ requests: [request], targets: [target] });

    expect(captureAccountingKey(provenance)).toBe('home-empty:ready:120x40');
    expect(selection.targets).toHaveLength(1);
    expect(hasMatchingProvenance({ left: request.provenance, right: target.provenance })).toBe(
      true,
    );

    const otherProvenance = ArtifactProvenanceSchema.parse({
      ...provenance,
      checkpointId: checkpointId('idle'),
    });
    expect(
      CaptureSelectionSchema.safeParse({
        requests: [request],
        targets: [{ provenance: otherProvenance, elementIds: [elementId('hero')] }],
      }).success,
    ).toBe(false);
    const driftedProvenance = ArtifactProvenanceSchema.parse({
      ...provenance,
      scenarioTitle: 'Different title for the same accounting key',
    });
    expect(
      CaptureSelectionSchema.safeParse({
        requests: [request],
        targets: [{ provenance: driftedProvenance, elementIds: [elementId('hero')] }],
      }).success,
    ).toBe(false);
    expect(
      CaptureSelectionSchema.safeParse({
        requests: [request],
        targets: [{ provenance, elementIds: [elementId('sidebar')] }],
      }).success,
    ).toBe(false);
    expect(
      CaptureRequestSchema.safeParse({
        provenance,
        elementIds: [elementId('hero'), elementId('hero')],
      }).success,
    ).toBe(false);
  });

  it('derives frame and crop identities from provenance without allowing key drift', () => {
    const provenance = createVisualProvenance();
    const frame = createFrameIdentity(provenance);
    const crop = createCropIdentity(provenance);

    expect(frameAccountingKey(provenance)).toBe('home-empty:ready:120x40:frame');
    expect(cropAccountingKey({ provenance, elementId: crop.elementId })).toBe(
      'home-empty:ready:120x40:crop:hero',
    );
    expect(frame.key).toBe(frameArtifactKey(provenance));
    expect(crop.parentFrameKey).toBe(frame.key);
    expect(ArtifactIdentitySchema.safeParse(frame).success).toBe(true);
    expect(ArtifactIdentitySchema.safeParse(crop).success).toBe(true);
    expect(FrameArtifactIdentitySchema.safeParse({ ...frame, key: 'wrong:frame' }).success).toBe(
      false,
    );
    expect(
      CropArtifactIdentitySchema.safeParse({ ...crop, parentFrameKey: 'wrong:frame' }).success,
    ).toBe(false);
  });

  it('enforces artifact geometry, locator identity, and every projection suffix', () => {
    const provenance = createVisualProvenance();
    const frame = createFrameArtifact({ provenance, includeDerived: true });
    const crop = createCropArtifact({ provenance, includeDerived: true });

    expect(ArtifactRecordSchema.safeParse(frame).success).toBe(true);
    expect(ArtifactRecordSchema.safeParse(crop).success).toBe(true);
    expect(
      ArtifactRecordSchema.safeParse({ ...frame, rect: { x: 0, y: 0, width: 3, height: 2 } })
        .success,
    ).toBe(false);
    expect(
      ArtifactRecordSchema.safeParse({ ...crop, dimensions: { cols: 3, rows: 1 } }).success,
    ).toBe(false);
    expect(
      ArtifactRecordSchema.safeParse({ ...crop, rect: { x: 119, y: 0, width: 2, height: 1 } })
        .success,
    ).toBe(false);
    expect(ArtifactRecordSchema.safeParse({ ...crop, locator: null }).success).toBe(false);
    for (const files of [
      { ...frame.files, ansi: relativeArtifactPath('frame.txt') },
      { ...frame.files, txt: relativeArtifactPath('frame.ansi') },
      { ...frame.files, cells: relativeArtifactPath('frame.json') },
      { ...frame.files, svg: relativeArtifactPath('frame.png') },
      { ...frame.files, png: relativeArtifactPath('frame.svg') },
    ]) {
      expect(ArtifactFilesSchema.safeParse(files).success).toBe(false);
    }
  });

  it('accepts a single visible grapheme cluster, including emoji sequences', () => {
    for (const grapheme of ['a', 'e\u0301', '✈️', '👩‍💻', '🏳️‍🌈', '🇵🇱']) {
      expect(isSafeTerminalGrapheme(grapheme)).toBe(true);
      expect(CellSchema.safeParse({ ...makeCell('x'), grapheme }).success).toBe(true);
    }
    for (const invalid of ['', 'ab', '\u001b', '\u200d']) {
      expect(isSafeTerminalGrapheme(invalid)).toBe(false);
    }
  });

  it('keeps wide graphemes aligned and refuses rectangles that split them', () => {
    const gridViewport = viewport({ cols: 3, rows: 1 });
    const cells = [[makeCell('👩‍💻', 2), makeContinuationCell(), makeCell('x')]];
    const grid: CellGrid = CellGridSchema.parse({
      schemaVersion: CELL_GRID_SCHEMA_VERSION,
      identity: createFrameIdentity(createVisualProvenance(gridViewport)),
      rect: { x: 0, y: 0, width: 3, height: 1 },
      cells,
    });

    expect(
      isCellRectOnGraphemeBoundaries(
        grid.cells,
        CellRectSchema.parse({ x: 0, y: 0, width: 2, height: 1 }),
      ),
    ).toBe(true);
    expect(
      isCellRectOnGraphemeBoundaries(
        grid.cells,
        CellRectSchema.parse({ x: 1, y: 0, width: 2, height: 1 }),
      ),
    ).toBe(false);
    expect(
      isCellRectOnGraphemeBoundaries(
        grid.cells,
        CellRectSchema.parse({ x: 0, y: 0, width: 1, height: 1 }),
      ),
    ).toBe(false);
    expect(
      CellGridSchema.safeParse({
        ...grid,
        cells: [[makeCell('👩‍💻', 2), makeCell('x'), makeCell('y')]],
      }).success,
    ).toBe(false);
  });

  it('rejects secrets and private URLs reconstructed across otherwise valid cells', () => {
    for (const hostile of [
      `npm_${'A'.repeat(24)}`,
      `glpat-${'B'.repeat(24)}`,
      'https://127.0.0.1/private',
      'postgres://db.internal/app',
    ]) {
      expect(hostile.length).toBeLessThanOrEqual(MAX_VIEWPORT_COLS);
      expect(CellGridSchema.safeParse(makeTextGrid(hostile)).success).toBe(false);
    }
    expect(CellGridSchema.safeParse(makeTextGrid('safe synthetic output')).success).toBe(true);
  });
});

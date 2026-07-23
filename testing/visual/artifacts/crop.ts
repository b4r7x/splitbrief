import { CropArtifactIdentitySchema, cropArtifactKey } from '../contracts/artifact-identity.js';
import {
  CellGridSchema,
  isCellRectOnGraphemeBoundaries,
  type CellGrid,
} from '../contracts/cells.js';
import type { ResolvedElementLocator } from '../locators/types.js';

export function createCropCellGrid(options: {
  readonly frame: CellGrid;
  readonly locator: ResolvedElementLocator;
}): CellGrid {
  const frame = CellGridSchema.parse(options.frame);
  if (frame.identity.kind !== 'frame') {
    throw new Error('A crop requires a canonical frame cell grid');
  }
  const { locator } = options;
  if (
    locator.provenance.sourceFrameKey !== frame.identity.key ||
    locator.provenance.scenarioId !== frame.identity.provenance.scenarioId ||
    locator.provenance.scenarioTitle !== frame.identity.provenance.scenarioTitle ||
    locator.provenance.fixtureVersion !== frame.identity.provenance.fixtureVersion ||
    locator.provenance.checkpointId !== frame.identity.provenance.checkpointId ||
    locator.provenance.viewport.cols !== frame.identity.provenance.viewport.cols ||
    locator.provenance.viewport.rows !== frame.identity.provenance.viewport.rows ||
    !isCellRectOnGraphemeBoundaries(frame.cells, locator.rect)
  ) {
    throw new Error('Crop locator does not identify a valid rectangle in its source frame');
  }

  const identity = CropArtifactIdentitySchema.parse({
    kind: 'crop',
    key: cropArtifactKey({
      provenance: frame.identity.provenance,
      elementId: locator.elementId,
    }),
    provenance: frame.identity.provenance,
    elementId: locator.elementId,
    parentFrameKey: frame.identity.key,
  });
  const rowStart = locator.rect.y - frame.rect.y;
  const columnStart = locator.rect.x - frame.rect.x;
  const cells = frame.cells
    .slice(rowStart, rowStart + locator.rect.height)
    .map((row) => row.slice(columnStart, columnStart + locator.rect.width));

  return CellGridSchema.parse({
    schemaVersion: frame.schemaVersion,
    identity,
    rect: locator.rect,
    cells,
  });
}

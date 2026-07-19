import {
  CropArtifactIdentitySchema,
  type CropArtifactIdentity,
  FrameArtifactIdentitySchema,
  type FrameArtifactIdentity,
  cropArtifactKey,
  frameArtifactKey,
} from './contracts/artifact-identity.js';
import {
  ArtifactFilesSchema,
  type ArtifactFiles,
  ArtifactRecordSchema,
  type ArtifactRecord,
} from './contracts/artifacts.js';
import { type Viewport, viewport } from './contracts/geometry.js';
import {
  checkpointId,
  elementId,
  relativeArtifactPath,
  scenarioId,
} from './contracts/identifiers.js';
import { ArtifactProvenanceSchema, type ArtifactProvenance } from './contracts/selection.js';

export function createVisualProvenance(
  viewportValue: Viewport = viewport({ cols: 120, rows: 40 }),
): ArtifactProvenance {
  return ArtifactProvenanceSchema.parse({
    scenarioId: scenarioId('home-empty'),
    scenarioTitle: 'Home empty',
    fixtureVersion: 1,
    checkpointId: checkpointId('ready'),
    viewport: viewportValue,
  });
}

export function createFrameIdentity(provenance: ArtifactProvenance): FrameArtifactIdentity {
  return FrameArtifactIdentitySchema.parse({
    kind: 'frame',
    key: frameArtifactKey(provenance),
    provenance,
    elementId: null,
    parentFrameKey: null,
  });
}

export function createCropIdentity(provenance: ArtifactProvenance): CropArtifactIdentity {
  const hero = elementId('hero');
  return CropArtifactIdentitySchema.parse({
    kind: 'crop',
    key: cropArtifactKey({ provenance, elementId: hero }),
    provenance,
    elementId: hero,
    parentFrameKey: frameArtifactKey(provenance),
  });
}

function createArtifactFiles(options: {
  readonly stem: string;
  readonly includeDerived: boolean;
}): ArtifactFiles {
  const { stem, includeDerived } = options;
  return ArtifactFilesSchema.parse({
    ansi: relativeArtifactPath(`${stem}.ansi`),
    txt: relativeArtifactPath(`${stem}.txt`),
    cells: relativeArtifactPath(`${stem}.cells.json`),
    svg: includeDerived ? relativeArtifactPath(`${stem}.svg`) : null,
    png: includeDerived ? relativeArtifactPath(`${stem}.png`) : null,
  });
}

export function createFrameArtifact(options: {
  readonly provenance: ArtifactProvenance;
  readonly includeDerived: boolean;
}): ArtifactRecord {
  const { provenance, includeDerived } = options;
  return ArtifactRecordSchema.parse({
    identity: createFrameIdentity(provenance),
    rect: { x: 0, y: 0, width: provenance.viewport.cols, height: provenance.viewport.rows },
    dimensions: provenance.viewport,
    files: createArtifactFiles({
      stem: 'home-empty/120x40/ready/frame',
      includeDerived,
    }),
    locator: null,
  });
}

export function createCropArtifact(options: {
  readonly provenance: ArtifactProvenance;
  readonly includeDerived: boolean;
}): ArtifactRecord {
  const { provenance, includeDerived } = options;
  return ArtifactRecordSchema.parse({
    identity: createCropIdentity(provenance),
    rect: { x: 1, y: 0, width: 2, height: 1 },
    dimensions: { cols: 2, rows: 1 },
    files: createArtifactFiles({
      stem: 'home-empty/120x40/ready/crop-hero',
      includeDerived,
    }),
    locator: { kind: 'layout', description: 'Home hero bounds' },
  });
}

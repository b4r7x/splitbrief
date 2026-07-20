import { describe, expect, it } from 'vitest';
import { elementId } from './contracts/identifiers.js';
import { DeterminismEnvelopeSchema } from './contracts/manifest-fields.js';
import { ManifestSchema } from './contracts/manifest.js';
import { CaptureSelectionSchema } from './contracts/selection.js';
import { PNG_RENDERER_METADATA } from './artifacts/png.js';
import { buildManifest } from './artifacts/manifest.js';
import {
  createCropArtifact,
  createFrameArtifact,
  createVisualProvenance,
} from './visual-contract-fixtures.js';

describe('visual artifact manifest', () => {
  it('rejects duplicate artifact keys and paths', () => {
    const manifest = createManifest();
    const frame = manifest.artifacts[0];
    if (frame === undefined) throw new Error('Manifest fixture is missing its frame');

    expect(
      ManifestSchema.safeParse({ ...manifest, artifacts: [...manifest.artifacts, frame] }).success,
    ).toBe(false);
  });

  it('rejects an artifact without dimensions', () => {
    const manifest = createManifest();
    const frame = manifest.artifacts[0];
    if (frame === undefined) throw new Error('Manifest fixture is missing its frame');
    const { dimensions: omitted, ...withoutDimensions } = frame;
    expect(omitted).toBeDefined();

    expect(
      ManifestSchema.safeParse({
        ...manifest,
        artifacts: [withoutDimensions, ...manifest.artifacts.slice(1)],
      }).success,
    ).toBe(false);
  });

  it('rejects an artifact without source provenance', () => {
    const manifest = createManifest();
    const frame = manifest.artifacts[0];
    if (frame === undefined) throw new Error('Manifest fixture is missing its frame');
    const { provenance: omitted, ...identityWithoutProvenance } = frame.identity;
    expect(omitted).toBeDefined();

    expect(
      ManifestSchema.safeParse({
        ...manifest,
        artifacts: [
          { ...frame, identity: identityWithoutProvenance },
          ...manifest.artifacts.slice(1),
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a crop whose parent frame has different provenance', () => {
    const manifest = createManifest();
    const crop = manifest.artifacts.find((artifact) => artifact.identity.kind === 'crop');
    if (crop === undefined) throw new Error('Manifest fixture is missing its crop');
    const alternateProvenance = {
      ...crop.identity.provenance,
      scenarioTitle: 'Different source frame',
    };
    const mismatchedFrame = createFrameArtifact({
      provenance: alternateProvenance,
      includeDerived: true,
    });

    expect(
      ManifestSchema.safeParse({ ...manifest, artifacts: [mismatchedFrame, crop] }).success,
    ).toBe(false);
  });
});

function createManifest() {
  const provenance = createVisualProvenance();
  const entry = { provenance, elementIds: [elementId('hero')] };
  return buildManifest({
    toolVersion: '0.1.0',
    gitRevision: 'abcdef1',
    selection: CaptureSelectionSchema.parse({ requests: [entry], targets: [entry] }),
    determinism: DeterminismEnvelopeSchema.parse({
      timezone: 'UTC',
      locale: 'en-US',
      term: 'xterm-256color',
      colorLevel: 3,
      hyperlinks: false,
      motion: false,
      clock: '2026-07-19T00:00:00.000Z',
      randomSeed: 'manifest-contract-v1',
    }),
    renderer: PNG_RENDERER_METADATA,
    artifacts: [
      createFrameArtifact({ provenance, includeDerived: true }),
      createCropArtifact({ provenance, includeDerived: true }),
    ],
    warnings: [],
    failures: [],
  });
}

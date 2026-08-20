import { describe, expect, it } from 'vitest';
import { assertUniqueArtifactPaths, createArtifactFiles, createRunKey } from './layout.js';
import {
  createCropIdentity,
  createFrameIdentity,
  createVisualProvenance,
} from '../visual-contract-fixtures.js';
import { CaptureSelectionSchema } from '../contracts/selection.js';
import { createPublicationLayout } from './publication.js';

const TERMINAL_PROFILES = ['unicode-color', 'unicode-mono', 'ascii-mono'] as const;

describe('visual artifact layout paths', () => {
  it('creates distinct relative paths and rejects collisions', () => {
    const provenance = createVisualProvenance();
    const frameFiles = createArtifactFiles({
      identity: createFrameIdentity(provenance),
      includeSvg: true,
      includePng: true,
    });
    const cropFiles = createArtifactFiles({
      identity: createCropIdentity(provenance),
      includeSvg: true,
      includePng: true,
    });

    expect(Object.values(frameFiles).every((path) => path === null || !path.startsWith('/'))).toBe(
      true,
    );
    expect(Object.values(cropFiles).every((path) => path === null || !path.startsWith('/'))).toBe(
      true,
    );
    expect(() => assertUniqueArtifactPaths([frameFiles, cropFiles])).not.toThrow();
    expect(() => assertUniqueArtifactPaths([frameFiles, frameFiles])).toThrow(
      'Duplicate artifact path',
    );
  });

  it('isolates publication roots by profile while keeping artifact stems unchanged', () => {
    const provenance = createVisualProvenance();
    const selections = TERMINAL_PROFILES.map((profile) =>
      CaptureSelectionSchema.parse({
        profile,
        requests: [{ provenance, elementIds: [] }],
        targets: [{ provenance, elementIds: [] }],
      }),
    );
    const runKeys = selections.map((selection) => createRunKey(selection));
    const runRoots = runKeys.map(
      (runKey) => createPublicationLayout({ outputRoot: 'profile-isolation', runKey }).runRoot,
    );
    const frameFiles = selections.map(() =>
      createArtifactFiles({
        identity: createFrameIdentity(provenance),
        includeSvg: true,
        includePng: true,
      }),
    );

    expect(new Set(runKeys).size).toBe(TERMINAL_PROFILES.length);
    expect(new Set(runRoots).size).toBe(TERMINAL_PROFILES.length);
    expect(new Set(frameFiles.map((files) => files.ansi)).size).toBe(1);
    expect(new Set(frameFiles.map((files) => files.cells)).size).toBe(1);
    const repeatedSelection = CaptureSelectionSchema.parse({
      profile: TERMINAL_PROFILES[0],
      requests: [{ provenance, elementIds: [] }],
      targets: [{ provenance, elementIds: [] }],
    });
    expect(createRunKey(repeatedSelection)).toBe(runKeys[0]);
  });
});

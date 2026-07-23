import { describe, expect, it } from 'vitest';
import { assertUniqueArtifactPaths, createArtifactFiles } from './layout.js';
import {
  createCropIdentity,
  createFrameIdentity,
  createVisualProvenance,
} from '../visual-contract-fixtures.js';

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
});

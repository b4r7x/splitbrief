import { describe, expect, it } from 'vitest';
import { resolveContainedArtifactPath } from './confinement.js';

describe('visual artifact confinement paths', () => {
  it('rejects traversal and absolute artifact paths', () => {
    const outputRoot = '/synthetic/artifact-root';

    for (const invalidPath of ['../outside.txt', '/absolute.txt', 'nested\\file.txt']) {
      expect(() =>
        resolveContainedArtifactPath({ root: outputRoot, relativePath: invalidPath }),
      ).toThrow(/must match pattern/);
    }
  });
});

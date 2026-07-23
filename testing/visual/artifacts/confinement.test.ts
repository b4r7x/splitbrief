import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveContainedArtifactPath } from './confinement.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('visual artifact confinement paths', () => {
  it('rejects traversal and absolute artifact paths', async () => {
    const outputRoot = await createOutputRoot();

    for (const invalidPath of ['../outside.txt', '/absolute.txt', 'nested\\file.txt']) {
      expect(() =>
        resolveContainedArtifactPath({ root: outputRoot, relativePath: invalidPath }),
      ).toThrow();
    }
    await expect(access(join(outputRoot, 'owned'))).rejects.toThrow();
  });
});

async function createOutputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'diptych-artifact-paths-'));
  temporaryRoots.push(root);
  return root;
}

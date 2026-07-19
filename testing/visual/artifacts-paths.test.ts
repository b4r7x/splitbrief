import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SafeId } from './contracts/identifiers.js';
import { elementId } from './contracts/identifiers.js';
import { CaptureSelectionSchema } from './contracts/selection.js';
import {
  assertUniqueArtifactPaths,
  createArtifactFiles,
  createPublicationLayout,
  createRunKey,
  preparePublicationLayout,
  publishPublicationLayout,
  resolveContainedArtifactPath,
} from './artifacts/paths.js';
import {
  createCropIdentity,
  createFrameIdentity,
  createVisualProvenance,
} from './visual-contract-fixtures.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('visual artifact paths', () => {
  it('rejects traversal, path separators, and shell-like publication IDs', async () => {
    const outputRoot = await createOutputRoot();

    for (const invalidId of [
      '../escape',
      'nested/id',
      'nested\\id',
      '$(touch-owned)',
      'run;echo-owned',
      'run wildcard',
    ]) {
      expect(() => createPublicationLayout({ outputRoot, runKey: invalidId as SafeId })).toThrow();
    }

    for (const invalidPath of ['../outside.txt', '/absolute.txt', 'nested\\file.txt']) {
      expect(() =>
        resolveContainedArtifactPath({ root: outputRoot, relativePath: invalidPath }),
      ).toThrow();
    }
    await expect(access(join(outputRoot, 'owned'))).rejects.toThrow();
  });

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

  it('replaces only the selected run namespace on a repeated publication', async () => {
    const outputRoot = await createOutputRoot();
    const selection = createSelection();
    const layout = createPublicationLayout({ outputRoot, runKey: createRunKey(selection) });
    const unrelatedRoot = join(outputRoot, 'unrelated-run');
    await mkdir(unrelatedRoot);
    await writeFile(join(unrelatedRoot, 'keep.txt'), 'keep', 'utf8');

    await preparePublicationLayout(layout);
    await writeFile(join(layout.stagingRoot, 'stale.txt'), 'stale', 'utf8');
    await publishPublicationLayout(layout);

    await preparePublicationLayout(layout);
    await writeFile(join(layout.stagingRoot, 'fresh.txt'), 'fresh', 'utf8');
    await publishPublicationLayout(layout);

    await expect(access(join(layout.runRoot, 'stale.txt'))).rejects.toThrow();
    await expect(readFile(join(layout.runRoot, 'fresh.txt'), 'utf8')).resolves.toBe('fresh');
    await expect(readFile(join(unrelatedRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(access(layout.stagingRoot)).rejects.toThrow();
    await expect(access(layout.previousRoot)).rejects.toThrow();
  });
});

function createSelection() {
  const provenance = createVisualProvenance();
  const entry = { provenance, elementIds: [elementId('hero')] };
  return CaptureSelectionSchema.parse({ requests: [entry], targets: [entry] });
}

async function createOutputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'diptych-artifact-paths-'));
  temporaryRoots.push(root);
  return root;
}

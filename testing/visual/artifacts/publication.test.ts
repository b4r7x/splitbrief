import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SafeId } from '../contracts/identifiers.js';
import { elementId } from '../contracts/identifiers.js';
import { CaptureSelectionSchema } from '../contracts/selection.js';
import { createRunKey } from './layout.js';
import {
  createPublicationLayout,
  preparePublicationLayout,
  publishPublicationLayout,
} from './publication.js';
import { createVisualProvenance } from '../visual-contract-fixtures.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('visual artifact publication paths', () => {
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

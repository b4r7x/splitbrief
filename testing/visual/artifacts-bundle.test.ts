import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { FrameArtifactIdentitySchema, frameArtifactKey } from './contracts/artifact-identity.js';
import { CellGridSchema } from './contracts/cells.js';
import { CheckpointDefinitionSchema, ScenarioDefinitionSchema } from './contracts/catalog.js';
import { viewport } from './contracts/geometry.js';
import { elementId } from './contracts/identifiers.js';
import { DeterminismEnvelopeSchema } from './contracts/manifest-fields.js';
import { parseManifest } from './contracts/manifest.js';
import { ArtifactProvenanceSchema, CaptureSelectionSchema } from './contracts/selection.js';
import { createPublicationLayout } from './artifacts/publication.js';
import { createRunKey } from './artifacts/layout.js';
import { writeArtifactBundle } from './artifacts/write.js';
import { parseTerminalFrame } from './terminal/parse.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('visual artifact bundle writer', () => {
  it('publishes validated frame and crop diagnostic, SVG, PNG, and manifest files', async () => {
    const fixture = await createBundleFixture();
    const outputRoot = await createOutputRoot();
    const publication = await writeArtifactBundle({
      ...fixture.options,
      outputRoot,
    });

    expect(publication.manifest.artifacts).toHaveLength(2);
    expect(publication.manifest.failures).toEqual([]);
    expect(publication.manifest.renderer).toMatchObject({
      name: 'sharp',
      version: sharp.versions.sharp,
      cellWidthPx: 8,
      cellHeightPx: 16,
    });
    const persistedManifest = parseManifest(
      JSON.parse(await readFile(publication.manifestPath, 'utf8')),
    );
    expect(persistedManifest).toEqual(publication.manifest);

    const frame = publication.manifest.artifacts.find(
      (artifact) => artifact.identity.kind === 'frame',
    );
    const crop = publication.manifest.artifacts.find(
      (artifact) => artifact.identity.kind === 'crop',
    );
    if (!frame || !crop || frame.files.png === null || crop.files.png === null) {
      throw new Error('Published bundle is missing its frame, crop, or PNG path');
    }
    for (const artifact of [frame, crop]) {
      for (const path of Object.values(artifact.files)) {
        if (path !== null)
          await expect(access(join(publication.runRoot, path))).resolves.toBeUndefined();
      }
    }

    const frameCells = CellGridSchema.parse(
      JSON.parse(await readFile(join(publication.runRoot, frame.files.cells), 'utf8')),
    );
    const cropCells = CellGridSchema.parse(
      JSON.parse(await readFile(join(publication.runRoot, crop.files.cells), 'utf8')),
    );
    const expectedCropCells = frameCells.cells
      .slice(crop.rect.y, crop.rect.y + crop.rect.height)
      .map((row) => row.slice(crop.rect.x, crop.rect.x + crop.rect.width));
    expect(cropCells.cells).toEqual(expectedCropCells);
    expect(cropCells.rect).toEqual(crop.rect);

    for (const artifact of [frame, crop]) {
      const pngPath = artifact.files.png;
      if (pngPath === null) throw new Error('PNG path disappeared after bundle validation');
      const metadata = await sharp(join(publication.runRoot, pngPath)).metadata();
      expect(metadata).toMatchObject({
        format: 'png',
        width: artifact.dimensions.cols * 8,
        height: artifact.dimensions.rows * 16,
      });
    }
    await expectNoTemporaryPublication(outputRoot, fixture.options.selection);
  });

  it('records raster failures without PNG success and removes staging', async () => {
    const fixture = await createBundleFixture();
    const outputRoot = await createOutputRoot();
    const publication = await writeArtifactBundle({
      ...fixture.options,
      outputRoot,
      rasterize: async () => {
        throw new Error('forced raster failure');
      },
    });

    expect(publication.manifest.artifacts).toHaveLength(2);
    expect(publication.manifest.artifacts.every((artifact) => artifact.files.png === null)).toBe(
      true,
    );
    expect(publication.manifest.failures.map((failure) => failure.stage)).toEqual(['png', 'png']);
    for (const artifact of publication.manifest.artifacts) {
      expect(artifact.files.svg).not.toBeNull();
      await expect(
        access(join(publication.runRoot, artifact.files.cells)),
      ).resolves.toBeUndefined();
    }
    await expectNoTemporaryPublication(outputRoot, fixture.options.selection);
  });

  it('removes staging and publishes no manifest after a fatal write failure', async () => {
    const fixture = await createBundleFixture();
    const outputRoot = await createOutputRoot();
    const layout = createPublicationLayout({
      outputRoot,
      runKey: createRunKey(fixture.options.selection),
    });

    await expect(
      writeArtifactBundle({
        ...fixture.options,
        outputRoot,
        writeArtifactFile: async () => {
          throw new Error('forced write failure');
        },
      }),
    ).rejects.toThrow('Visual artifact bundle publication failed');
    await expect(pathExists(layout.stagingRoot)).resolves.toBe(false);
    await expect(pathExists(layout.runRoot)).resolves.toBe(false);
  });
});

async function createBundleFixture() {
  const frameViewport = viewport({ cols: 40, rows: 8 });
  const checkpoint = CheckpointDefinitionSchema.parse({
    id: 'success',
    title: 'Successful summary',
    kind: 'success',
    marker: 'Visual fixture workflow complete',
    timeoutMs: 5_000,
  });
  const scenario = ScenarioDefinitionSchema.parse({
    id: 'summary-success',
    title: 'Summary success',
    surface: { kind: 'screen', screen: 'summary' },
    fixtureVersion: 1,
    viewports: [frameViewport],
    checkpoints: [checkpoint],
    elements: [{ id: 'summary-hero', title: 'Summary outcome', required: true }],
  });
  const provenance = ArtifactProvenanceSchema.parse({
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    fixtureVersion: scenario.fixtureVersion,
    checkpointId: checkpoint.id,
    viewport: frameViewport,
  });
  const identity = FrameArtifactIdentitySchema.parse({
    kind: 'frame',
    key: frameArtifactKey(provenance),
    provenance,
    elementId: null,
    parentFrameKey: null,
  });
  const grid = await parseTerminalFrame({
    ansi: '\u001b[1;36mVisual fixture workflow complete\u001b[0m\nBounded details',
    identity,
    projectRoot: process.cwd(),
  });
  const summaryHero = elementId('summary-hero');
  const selection = CaptureSelectionSchema.parse({
    requests: [{ provenance, elementIds: [summaryHero] }],
    targets: [{ provenance, elementIds: [summaryHero] }],
  });
  const determinism = DeterminismEnvelopeSchema.parse({
    timezone: 'UTC',
    locale: 'en-US',
    term: 'xterm-256color',
    colorLevel: 3,
    hyperlinks: false,
    motion: false,
    clock: '2026-07-19T00:00:00.000Z',
    randomSeed: 'artifact-bundle-v1',
  });

  return {
    options: {
      toolVersion: '0.1.0',
      gitRevision: 'abcdef1',
      selection,
      determinism,
      captures: [{ scenario, checkpoint, grid }],
    },
  };
}

async function createOutputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'splitbrief-visual-bundle-'));
  temporaryRoots.push(root);
  return root;
}

async function expectNoTemporaryPublication(
  outputRoot: string,
  selection: ReturnType<typeof CaptureSelectionSchema.parse>,
): Promise<void> {
  const layout = createPublicationLayout({ outputRoot, runKey: createRunKey(selection) });
  await expect(pathExists(layout.stagingRoot)).resolves.toBe(false);
  await expect(pathExists(layout.previousRoot)).resolves.toBe(false);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

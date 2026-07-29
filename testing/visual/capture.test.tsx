import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { findVisualScenario } from './catalog.js';
import type { Viewport } from './contracts/geometry.js';
import type { Failure } from './contracts/failures.js';
import { elementId, type ElementId } from './contracts/identifiers.js';
import {
  ArtifactProvenanceSchema,
  CaptureSelectionSchema,
  type CaptureSelection,
} from './contracts/selection.js';
import { createPublicationLayout } from './artifacts/publication.js';
import { createRunKey } from './artifacts/layout.js';
import { captureGallery } from './gallery/capture.js';
import { mountGalleryScenario, type GalleryCaptureHandle } from './gallery/mount.js';
import { parseTerminalFrame } from './terminal/parse.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('visual gallery capture orchestration', () => {
  it('captures two scenarios at two viewports sequentially in catalog order into one manifest', async () => {
    const home = requireScenario('home-empty');
    const workflow = requireScenario('workflow-question');
    const captures = [
      captureEntry(workflow.id, workflow.viewports[1], []),
      captureEntry(home.id, home.viewports[1], []),
      captureEntry(workflow.id, workflow.viewports[0], []),
      captureEntry(home.id, home.viewports[0], []),
    ];
    const selection = selectionFrom(captures);
    const outputRoot = await createOutputRoot();
    const events: string[] = [];
    let activeMounts = 0;
    let maximumActiveMounts = 0;

    const publication = await captureGallery({
      outputRoot,
      projectRoot: process.cwd(),
      toolVersion: '0.1.0',
      gitRevision: 'abcdef1',
      selection,
      mountScenario: async (options) => {
        activeMounts += 1;
        maximumActiveMounts = Math.max(maximumActiveMounts, activeMounts);
        events.push(`mount:${captureLabel(options.scenario.id, options.viewport)}`);
        try {
          const handle = await mountGalleryScenario(options);
          return trackUnmount(handle, () => {
            events.push(`unmount:${captureLabel(options.scenario.id, options.viewport)}`);
            activeMounts -= 1;
          });
        } catch (error) {
          activeMounts -= 1;
          throw error;
        }
      },
    });

    expect(maximumActiveMounts).toBe(1);
    expect(activeMounts).toBe(0);
    expect(events).toEqual([
      'mount:home-empty:120x40',
      'unmount:home-empty:120x40',
      'mount:home-empty:80x24',
      'unmount:home-empty:80x24',
      'mount:workflow-question:120x40',
      'unmount:workflow-question:120x40',
      'mount:workflow-question:80x24',
      'unmount:workflow-question:80x24',
    ]);
    expect(publication.manifest.artifacts).toHaveLength(4);
    expect(publication.manifest.failures).toEqual([]);
    expect(
      publication.manifest.artifacts.map((artifact) => artifact.identity.provenance.scenarioId),
    ).toEqual(['home-empty', 'home-empty', 'workflow-question', 'workflow-question']);
    const manifestFiles = (await readdir(outputRoot, { recursive: true })).filter((path) =>
      path.endsWith('manifest.json'),
    );
    expect(manifestFiles).toHaveLength(1);
    expect(isContained({ root: outputRoot, path: publication.runRoot })).toBe(true);
    for (const artifact of publication.manifest.artifacts) {
      for (const path of Object.values(artifact.files)) {
        if (path !== null) {
          const artifactPath = join(publication.runRoot, path);
          expect(isContained({ root: outputRoot, path: artifactPath })).toBe(true);
          await expect(access(artifactPath)).resolves.toBeUndefined();
        }
      }
    }
  });

  it('continues after fixture and parser failures and records locator identity after cleanup', async () => {
    const scenario = requireScenario('home-empty');
    const hero = elementId('hero');
    const selection = selectionFrom([
      captureEntry(scenario.id, scenario.viewports[0], []),
      captureEntry(scenario.id, scenario.viewports[1], []),
      captureEntry(scenario.id, scenario.viewports[2], [hero]),
    ]);
    const outputRoot = await createOutputRoot();
    const terminalBefore = terminalSizeStore.get();
    const dateNowBefore = Date.now;
    let parseCalls = 0;
    let activeMounts = 0;

    const publication = await captureGallery({
      outputRoot,
      projectRoot: process.cwd(),
      toolVersion: '0.1.0',
      gitRevision: null,
      selection,
      mountScenario: async (options) => {
        if (options.viewport.cols === 120) throw new Error('forced fixture failure');
        activeMounts += 1;
        const handle = await mountGalleryScenario(options);
        return trackUnmount(handle, () => {
          activeMounts -= 1;
        });
      },
      parseFrame: async (options) => {
        parseCalls += 1;
        if (parseCalls === 1) throw new Error('forced parser failure');
        return parseTerminalFrame({
          ...options,
          ansi: options.ansi.replace(requireCheckpoint(scenario).marker, 'removed marker'),
        });
      },
    });

    expect(activeMounts).toBe(0);
    expect(Date.now).toBe(dateNowBefore);
    expect(terminalSizeStore.get()).toEqual(terminalBefore);
    expect(publication.manifest.artifacts).toHaveLength(1);
    expect(publication.manifest.failures.map((failure) => failure.stage)).toEqual([
      'fixture',
      'terminal',
      'locator',
    ]);
    expect(publication.manifest.failures.map((failure) => failureSelectionLabel(failure))).toEqual([
      'home-empty:120x40',
      'home-empty:80x24',
      'home-empty:60x18',
    ]);
    expect(publication.manifest.failures[2]).toMatchObject({
      stage: 'locator',
      elementId: hero,
      parentFrameKey: 'home-empty:ready:60x18:frame',
    });
  });

  it('cleans the mounted capture and staging after a writer exception without escaping root', async () => {
    const scenario = requireScenario('home-empty');
    const selection = selectionFrom([captureEntry(scenario.id, scenario.viewports[2], [])]);
    const outputRoot = await createOutputRoot();
    const layout = createPublicationLayout({
      outputRoot,
      runKey: createRunKey(selection),
    });
    const terminalBefore = terminalSizeStore.get();
    const dateNowBefore = Date.now;

    await expect(
      captureGallery({
        outputRoot,
        projectRoot: process.cwd(),
        toolVersion: '0.1.0',
        gitRevision: null,
        selection,
        writeArtifactFile: async () => {
          throw new Error('forced writer failure');
        },
      }),
    ).rejects.toThrow(
      'Visual capture publication failed while handling home-empty/60x18/ready/frame.ansi',
    );
    expect(Date.now).toBe(dateNowBefore);
    expect(terminalSizeStore.get()).toEqual(terminalBefore);
    await expect(pathExists(layout.stagingRoot)).resolves.toBe(false);
    await expect(pathExists(layout.runRoot)).resolves.toBe(false);
    expect(await readdir(outputRoot)).toEqual([]);
  });
});

interface CaptureEntryInput {
  readonly provenance: ReturnType<typeof ArtifactProvenanceSchema.parse>;
  readonly elementIds: readonly ElementId[];
}

function captureEntry(
  scenarioId: string,
  viewport: Viewport | undefined,
  elementIds: readonly ElementId[],
): CaptureEntryInput {
  const scenario = requireScenario(scenarioId);
  const checkpoint = scenario.checkpoints[0];
  if (checkpoint === undefined || viewport === undefined) {
    throw new Error(`Scenario ${scenarioId} is missing its checkpoint or requested viewport`);
  }
  return {
    provenance: ArtifactProvenanceSchema.parse({
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      fixtureVersion: scenario.fixtureVersion,
      checkpointId: checkpoint.id,
      viewport,
    }),
    elementIds,
  };
}

function selectionFrom(entries: readonly CaptureEntryInput[]): CaptureSelection {
  return CaptureSelectionSchema.parse({
    requests: [...entries].reverse(),
    targets: [...entries].reverse(),
  });
}

function requireScenario(id: string) {
  const scenario = findVisualScenario(id);
  if (scenario === undefined) throw new Error(`Missing visual scenario ${id}`);
  return scenario;
}

function requireCheckpoint(scenario: ReturnType<typeof requireScenario>) {
  const checkpoint = scenario.checkpoints[0];
  if (checkpoint === undefined) throw new Error(`Missing checkpoint for ${scenario.id}`);
  return checkpoint;
}

function trackUnmount(
  handle: GalleryCaptureHandle,
  afterUnmount: () => void,
): GalleryCaptureHandle {
  let tracked = false;
  return {
    ...handle,
    unmount: async () => {
      try {
        await handle.unmount();
      } finally {
        if (!tracked) {
          tracked = true;
          afterUnmount();
        }
      }
    },
  };
}

function captureLabel(scenarioId: string, viewport: Viewport): string {
  return `${scenarioId}:${viewport.cols}x${viewport.rows}`;
}

function failureSelectionLabel(failure: Failure): string {
  const provenance =
    failure.stage === 'locator'
      ? failure.provenance
      : failure.stage === 'cleanup' && failure.target.kind === 'capture'
        ? failure.target.provenance
        : 'provenance' in failure
          ? failure.provenance
          : null;
  return provenance === null
    ? 'run'
    : `${provenance.scenarioId}:${provenance.viewport.cols}x${provenance.viewport.rows}`;
}

function isContained(options: { readonly root: string; readonly path: string }): boolean {
  const relation = relative(options.root, options.path);
  return relation.length > 0 && !relation.startsWith('..') && !isAbsolute(relation);
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

async function createOutputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'splitbrief-capture-'));
  temporaryRoots.push(root);
  return root;
}

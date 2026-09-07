import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runTuiShots,
  type TuiShotsCaptureOptions,
  type TuiShotsCaptureResult,
  type TuiShotsDependencies,
} from './tui-shots.js';
import { VISUAL_FIXTURE_VERSION } from '../testing/visual/catalog.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('tui-shots CLI behavior', () => {
  it('prints help and catalog listings without resolving git or mounting a capture', async () => {
    const cwd = await createTemporaryCwd();
    const capture = vi.fn<CaptureFunction>();
    const gitRevision = vi.fn(async () => 'abcdef1');

    const help = createHarness({ cwd, capture, gitRevision });
    expect(await runTuiShots(['--help'], help.dependencies)).toBe(0);
    expect(help.stdout()).toContain('Usage: tui-shots [options]');
    for (const option of ['--scenario', '--viewport', '--element', '--profile', '--output']) {
      expect(help.stdout()).toContain(option);
    }
    expect(help.stderr()).toBe('');

    const list = createHarness({ cwd, capture, gitRevision });
    expect(await runTuiShots(['--list'], list.dependencies)).toBe(0);
    expect(list.stdout()).toContain('visual catalog v1');
    expect(list.stdout()).toContain('home-empty');
    expect(list.stdout()).toContain('workflow-question');
    expect(list.stderr()).toBe('');
    expect(capture).not.toHaveBeenCalled();
    expect(gitRevision).not.toHaveBeenCalled();
  });

  it('deduplicates repeated filters and passes exact selection provenance, elements, and output', async () => {
    const cwd = await createTemporaryCwd();
    const selectedOutput = '.test-artifacts/ui/unit-selection';
    const capture = vi.fn<CaptureFunction>(async (options) =>
      successfulCapture(options.outputRoot, 2),
    );
    const harness = createHarness({ cwd, capture, gitRevision: async () => 'abcdef1' });

    const exitCode = await runTuiShots(
      [
        '--scenario',
        'home-empty',
        '--scenario',
        'home-empty',
        '--viewport',
        '80x24',
        '--viewport',
        '80x24',
        '--element',
        'header',
        '--element',
        'header',
        '--output',
        selectedOutput,
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(capture).toHaveBeenCalledTimes(1);
    const options = capture.mock.calls[0]?.[0];
    if (options === undefined) throw new Error('Capture options were not recorded');
    expect(options).toMatchObject({
      outputRoot: resolve(cwd, selectedOutput),
      projectRoot: cwd,
      toolVersion: '9.8.7',
      gitRevision: 'abcdef1',
    });
    expect(options.selection.requests).toHaveLength(1);
    expect(options.selection.targets).toHaveLength(1);
    expect(options.selection.targets[0]).toEqual({
      provenance: {
        scenarioId: 'home-empty',
        scenarioTitle: 'Home · empty project',
        fixtureVersion: VISUAL_FIXTURE_VERSION,
        checkpointId: 'ready',
        viewport: { cols: 80, rows: 24 },
      },
      elementIds: ['header'],
    });
    expect(harness.stdout()).toBe(
      [
        'tui-shots: complete',
        'output: .test-artifacts/ui/unit-selection/catalog-run',
        'manifest: .test-artifacts/ui/unit-selection/catalog-run/manifest.json',
        'captures: 1',
        'artifacts: 2/2',
        'warnings: 0',
        'failures: 0',
        '',
      ].join('\n'),
    );
    expect(harness.stderr()).toBe('');
  });

  it.each(['unicode-color', 'unicode-mono', 'ascii-mono'] as const)(
    'passes one homogeneous %s profile into the selection',
    async (profile) => {
      const cwd = await createTemporaryCwd();
      const capture = vi.fn<CaptureFunction>(async (options) =>
        successfulCapture(options.outputRoot, 1),
      );
      const harness = createHarness({ cwd, capture, gitRevision: async () => null });

      expect(
        await runTuiShots(
          ['--scenario', 'home-empty', '--viewport', '80x24', '--profile', profile],
          harness.dependencies,
        ),
      ).toBe(0);

      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]?.[0]?.selection).toMatchObject({ profile });
    },
  );

  it('uses unicode-color as the compatibility default', async () => {
    const cwd = await createTemporaryCwd();
    const capture = vi.fn<CaptureFunction>(async (options) =>
      successfulCapture(options.outputRoot, 1),
    );
    const harness = createHarness({ cwd, capture, gitRevision: async () => null });

    expect(
      await runTuiShots(['--scenario', 'home-empty', '--viewport', '80x24'], harness.dependencies),
    ).toBe(0);
    expect(capture.mock.calls[0]?.[0]?.selection).toMatchObject({ profile: 'unicode-color' });
  });

  it.each([
    ['unknown profile', ['--profile', 'future-terminal'], 'Unknown terminal profile'],
    [
      'mixed profiles',
      ['--profile', 'unicode-color', '--profile', 'ascii-mono'],
      'Terminal profile must be homogeneous',
    ],
  ] as const)('rejects %s before capture', async (_name, profileArgs, message) => {
    const cwd = await createTemporaryCwd();
    const capture = vi.fn<CaptureFunction>();
    const gitRevision = vi.fn(async () => 'abcdef1');
    const harness = createHarness({ cwd, capture, gitRevision });

    expect(
      await runTuiShots(
        ['--scenario', 'home-empty', '--viewport', '80x24', ...profileArgs],
        harness.dependencies,
      ),
    ).toBe(1);
    expect(harness.stderr()).toContain(`Error: ${message}`);
    expect(capture).not.toHaveBeenCalled();
    expect(gitRevision).not.toHaveBeenCalled();
  });

  it('combines repeated scenario-local viewport flags without a cross-product', async () => {
    const cwd = await createTemporaryCwd();
    const capture = vi.fn<CaptureFunction>(async (options) =>
      successfulCapture(options.outputRoot, options.selection.targets.length),
    );
    const harness = createHarness({ cwd, capture, gitRevision: async () => null });

    expect(
      await runTuiShots(
        [
          '--scenario',
          'home-empty',
          '--viewport',
          '80x24',
          '--viewport',
          '60x18',
          '--profile',
          'unicode-color',
        ],
        harness.dependencies,
      ),
    ).toBe(0);

    expect(capture.mock.calls[0]?.[0]?.selection.targets).toHaveLength(2);
  });

  it.each([
    {
      name: 'unknown scenario',
      args: ['--scenario', 'missing-scenario'],
      message: 'Unknown scenario "missing-scenario"',
    },
    {
      name: 'malformed viewport',
      args: ['--scenario', 'home-empty', '--viewport', 'wide'],
      message: 'Invalid viewport "wide"',
    },
    {
      name: 'unsupported viewport',
      args: ['--scenario', 'home-empty', '--viewport', '100x30'],
      message: 'Unsupported viewport "100x30"',
    },
    {
      name: 'element missing from one selected scenario',
      args: ['--scenario', 'home-empty', '--scenario', 'summary-success', '--element', 'hero'],
      message: 'Element "hero" is not declared by scenario summary-success',
    },
    {
      name: 'output escape',
      args: ['--scenario', 'home-empty', '--output', '../escape'],
      message: 'Output root must remain beneath .test-artifacts/ui',
    },
  ])('returns nonzero without capture for $name', async ({ args, message }) => {
    const cwd = await createTemporaryCwd();
    const capture = vi.fn<CaptureFunction>();
    const gitRevision = vi.fn(async () => 'abcdef1');
    const harness = createHarness({ cwd, capture, gitRevision });

    expect(await runTuiShots(args, harness.dependencies)).toBe(1);
    expect(harness.stdout()).toBe('');
    expect(harness.stderr()).toContain(`Error: ${message}`);
    expect(capture).not.toHaveBeenCalled();
    expect(gitRevision).not.toHaveBeenCalled();
  });

  it('returns nonzero and prints a stable failed-capture summary', async () => {
    const cwd = await createTemporaryCwd();
    const capture: CaptureFunction = async (options) => ({
      ...successfulCapture(options.outputRoot, 1),
      warningCount: 1,
      failureCount: 2,
    });
    const args = [
      '--scenario',
      'home-empty',
      '--viewport',
      '60x18',
      '--element',
      'header',
      '--output',
      '.test-artifacts/ui/failed-selection',
    ];

    const first = createHarness({ cwd, capture, gitRevision: async () => null });
    const second = createHarness({ cwd, capture, gitRevision: async () => null });
    expect(await runTuiShots(args, first.dependencies)).toBe(1);
    expect(await runTuiShots(args, second.dependencies)).toBe(1);
    expect(first.stdout()).toBe(second.stdout());
    expect(first.stderr()).toBe('');
    expect(first.stdout()).toBe(
      [
        'tui-shots: failed',
        'output: .test-artifacts/ui/failed-selection/catalog-run',
        'manifest: .test-artifacts/ui/failed-selection/catalog-run/manifest.json',
        'captures: 1',
        'artifacts: 1/2',
        'warnings: 1',
        'failures: 2',
        '',
      ].join('\n'),
    );
  });
});

type CaptureFunction = (options: TuiShotsCaptureOptions) => Promise<TuiShotsCaptureResult>;

function createHarness(options: {
  readonly cwd: string;
  readonly capture: CaptureFunction;
  readonly gitRevision: TuiShotsDependencies['gitRevision'];
}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    dependencies: {
      cwd: options.cwd,
      capture: options.capture,
      gitRevision: options.gitRevision,
      toolVersion: '9.8.7',
      io: {
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
      },
    } satisfies TuiShotsDependencies,
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
  };
}

function successfulCapture(outputRoot: string, artifactCount: number): TuiShotsCaptureResult {
  const runRoot = resolve(outputRoot, 'catalog-run');
  return {
    runRoot,
    manifestPath: resolve(runRoot, 'manifest.json'),
    artifactCount,
    warningCount: 0,
    failureCount: 0,
  };
}

async function createTemporaryCwd(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'splitbrief-tui-shots-'));
  temporaryRoots.push(root);
  return root;
}

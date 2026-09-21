import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { saveDetectionCache } from '../../detection/cache.js';
import { switchSeatOffer } from './builders/task.js';
import { loadSeatSwapContext } from './seat-swap-context.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

async function projectWithRememberedTools(
  name: string,
  cliTools: Parameters<typeof saveDetectionCache>[0]['snapshot']['cliTools'],
): Promise<string> {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  await saveDetectionCache({
    projectDir,
    snapshot: {
      contextKey: 'readiness-remembered',
      fetchedAt: Date.now(),
      validatedAt: Date.now(),
      generation: 1,
      requestId: 1,
      providers: [],
      cliTools,
    },
  });
  return projectDir;
}

describe('loadSeatSwapContext', () => {
  it('reads the remembered tools regardless of the context they were probed under', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-remembered', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex' },
    });

    expect(context).toEqual({
      seat: 'build',
      currentTool: 'codex',
      detectedTools: [
        { tool: 'codex', ready: true },
        { tool: 'claude-code', ready: true },
      ],
    });
    expect(switchSeatOffer(context)).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code' }],
    });
  });

  it('marks a tool that is not ready so the offer drops it', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-unready', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unavailable', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex' },
    });

    expect(context?.detectedTools).toContainEqual({ tool: 'claude-code', ready: false });
    expect(switchSeatOffer(context)).toBeUndefined();
  });

  it('leaves currentTool empty for a seat no CLI tool hosts', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-api-seat', [
      cliDetectionFor('ready', 'codex'),
    ]);

    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner: makeConfig().implementer,
    });

    expect(context?.currentTool).toBe('');
    expect(switchSeatOffer(context)).toEqual({ seat: 'build', candidates: [{ tool: 'codex' }] });
  });

  it('offers nothing when the project has no remembered detection', async () => {
    const projectDir = createTempDir('seat-swap-no-cache');
    dirs.push(projectDir);

    await expect(
      loadSeatSwapContext({
        projectDir,
        seat: 'build',
        runner: { kind: 'cli', tool: 'codex' },
      }),
    ).resolves.toBeUndefined();
  });
});

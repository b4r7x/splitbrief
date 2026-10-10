import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { configPath } from '../../../core/config/load/document.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { switchSeatOffer } from './builders/task.js';
import { loadSeatSwapContext, readSeatFallbackOfRecord } from './seat-swap-context.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

async function projectWithRememberedTools(
  name: string,
  cliTools: Parameters<typeof rememberDetectedTools>[1],
): Promise<string> {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  await rememberDetectedTools(projectDir, cliTools);
  return projectDir;
}

describe('loadSeatSwapContext', () => {
  it('returns a read failure for invalid config instead of throwing', () => {
    const projectDir = createTempDir('seat-fallback-invalid-config');
    dirs.push(projectDir);
    const config = makeConfig();
    writeConfig(projectDir, config);
    writeFileSync(configPath(projectDir), 'version: 3\nplanner:\n  kind: cli\n  tool: invalid\n');
    expect(readSeatFallbackOfRecord({ projectDir, seat: 'build', config })).toEqual({
      kind: 'read-failed',
    });
  });

  it('reads the single BUILD fallback when a halt carries a former profile name', async () => {
    const projectDir = await projectWithRememberedTools('seat-fallback-former-profile', [
      cliDetectionFor('ready', 'claude-code'),
    ]);
    const runner = { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } } as const;
    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner,
      config: makeConfig({ implementer: runner }),
      implementerProfile: 'former-profile',
    });
    expect(context?.fallback).toEqual(runner.fallback);
  });

  it('reads the remembered tools regardless of the context they were probed under', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-remembered', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex' },
      config: makeConfig(),
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
      config: makeConfig(),
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
      config: makeConfig(),
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
        config: makeConfig(),
      }),
    ).resolves.toBeUndefined();
  });

  it("leads with the seat's declared fallback when the pass saw its tool ready", async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-fallback-ready', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      config: makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'codex',
          fallback: { tool: 'claude-code', model: 'sonnet', effort: 'high' },
        },
      }),
      runner: {
        kind: 'cli',
        tool: 'codex',
        fallback: { tool: 'claude-code', model: 'sonnet', effort: 'high' },
      },
    });

    expect(context?.fallbackBlockedReason).toBeUndefined();
    expect(context?.detectedTools[0]).toEqual({
      tool: 'claude-code',
      model: 'sonnet',
      effort: 'high',
      ready: true,
    });
    expect(switchSeatOffer(context)).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet', effort: 'high' }],
    });
  });

  it('offers an unverified fallback and never duplicates its bare detection', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-fallback-unverified', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unverified', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code', model: 'sonnet' } },
      config: makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'codex',
          fallback: { tool: 'claude-code', model: 'sonnet' },
        },
      }),
    });

    expect(context?.detectedTools.filter((tool) => tool.tool === 'claude-code')).toEqual([
      { tool: 'claude-code', model: 'sonnet', ready: true },
    ]);
  });

  it('names why a declared fallback is not offered', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-fallback-blocked', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unauthenticated', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      }),
    });

    expect(context?.fallbackBlockedReason).toBe('unauthenticated');
    expect(context?.detectedTools).toContainEqual({ tool: 'claude-code', ready: false });
    expect(switchSeatOffer(context)).toBeUndefined();
  });

  it('calls a declared fallback with no executable not installed', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-fallback-absent', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unavailable', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      }),
    });

    expect(context?.fallbackBlockedReason).toBe('not installed');
  });
});

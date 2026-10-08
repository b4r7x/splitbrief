import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import {
  fakeDeps,
  prepareExecutionMock,
  runHeadlessMock,
  setupRunnerTrustIsolation,
  writeConfigMarker,
} from '#testing/helpers/start-command.js';
import { writeEmptyDetectionCache } from '#testing/helpers/write-empty-detection-cache.js';
import { routerStore } from '../../../stores/navigation/router.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { registerStartCommand } from './register.js';

setupFetchMock();
setupRunnerTrustIsolation();

async function startStreams(
  projectDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; rejection: unknown }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  let rejection: unknown = null;
  try {
    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync(['node', 'splitbrief', 'start', '--project', projectDir, ...args]);
  } catch (caught) {
    rejection = caught;
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return { stdout: out.join(''), stderr: err.join(''), rejection };
}

async function startIn(projectDir: string, args: string[]): Promise<string> {
  const streams = await startStreams(projectDir, args);
  if (streams.rejection !== null) throw streams.rejection;
  return streams.stdout;
}

function blockedReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    status: 'blocked',
    counts: { ok: 0, info: 0, warning: 0, blocker: 1 },
    nextAction: { kind: 'exit', label: 'Exit', reason: 'Fix the configured runner.' },
    sections: [
      {
        id: 'runners',
        title: 'Runners',
        checks: [
          {
            id: 'runners.preparation.planner',
            severity: 'blocker',
            summary: 'The configured runner could not be admitted.',
          },
        ],
      },
    ],
    metadata: {},
  };
}

function project(name: string): string {
  const projectDir = realpathSync(createTempDir(name));
  createTestGitRepo(projectDir);
  writeConfigMarker(projectDir);
  writeEmptyDetectionCache(projectDir);
  resetAllStores();
  routerStore.init({ screen: 'home' });
  process.stdin.isTTY = true;
  runHeadlessMock.mockClear();
  runHeadlessMock.mockResolvedValue(undefined);
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}', { status: 200 }));
  return projectDir;
}

describe('start --plain', () => {
  it('reaches the headless dispatch and asks for the plain rendering', async () => {
    const projectDir = project('start-plain-dispatch');
    try {
      const out = await startIn(projectDir, ['--plain', 'plain dispatched feature']);

      expect(runHeadlessMock).toHaveBeenCalledOnce();
      expect(runHeadlessMock.mock.calls[0]?.[0]).toMatchObject({
        plain: true,
        prepared: {
          purpose: 'new-workflow',
          runtime: { feature: 'plain dispatched feature' },
        },
      });
      // The readiness record belongs to the NDJSON rendering only.
      expect(out).not.toContain('readiness_report');
    } finally {
      cleanupTempDir(projectDir);
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }, 30_000);

  it('leaves --json without the plain flag and still writes the readiness record', async () => {
    const projectDir = project('start-json-dispatch');
    try {
      const out = await startIn(projectDir, ['--json', 'json dispatched feature']);

      expect(runHeadlessMock).toHaveBeenCalledOnce();
      expect(runHeadlessMock.mock.calls[0]?.[0]).not.toHaveProperty('plain');
      expect(out).toContain('readiness_report');
    } finally {
      cleanupTempDir(projectDir);
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }, 30_000);

  it('prints the readiness blockers on stderr before naming them in the error', async () => {
    const projectDir = project('start-plain-blocked');
    prepareExecutionMock.mockResolvedValueOnce({
      kind: 'blocked',
      report: blockedReport(projectDir),
    });
    try {
      const streams = await startStreams(projectDir, ['--plain', 'blocked feature']);

      expect(streams.rejection).not.toBeNull();
      expect((streams.rejection as Error).message).toContain('Run readiness blocked');
      expect(streams.stderr).toContain('runners.preparation.planner');
      expect(streams.stderr).toContain('The configured runner could not be admitted.');
      expect(streams.stdout).not.toContain('runners.preparation.planner');
      expect(runHeadlessMock).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(projectDir);
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }, 30_000);

  it('refuses --plain without a feature', async () => {
    const projectDir = project('start-plain-no-feature');
    try {
      await expect(startIn(projectDir, ['--plain'])).rejects.toThrow(
        '--plain requires a feature argument',
      );
      expect(runHeadlessMock).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(projectDir);
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

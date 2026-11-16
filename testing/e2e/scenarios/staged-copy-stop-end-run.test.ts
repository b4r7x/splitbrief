import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { sandboxRoot, sandboxTempDir } from '../../../src/engine/runners/sandbox/state/paths.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  endImplementerHold,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

function sandboxTempFolders(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('sb-'));
}

/** A staged-copy run that the user stopped during its build, and the temp folders the stop kept. */
async function stoppedStagedRun() {
  fixture = createStopContinueFixture(undefined, { isolation: 'staged-copy' });
  const target = fixture;
  // The sandbox temp folders sit in the system temp folder; the CLI of this run puts them in its own.
  const temp = join(target.tmpDir, 'tmp');
  mkdirSync(temp);
  vi.stubEnv('TMPDIR', temp);

  const parked = await startAndSignal(target, 'SIGINT', target.projectDir);
  expect(parked.exitCode).toBe(130);
  await endImplementerHold(target);

  const workspace = readState(target, parked.sessionId).workspace;
  if (workspace?.kind !== 'staged-copy') throw new Error('the stopped run has no staged copy');
  const kept = sandboxTempFolders(temp);
  expect(kept).toContain(basename(sandboxTempDir(sandboxRoot(workspace.path, 'implementer'))));
  return { target, temp, sessionId: parked.sessionId, workspace: workspace.path, kept };
}

describe('e2e: End run of a stopped staged-copy run', { timeout: 240_000 }, () => {
  it('removes the temp folders that the stop kept for the sandboxes of the staged copy', async () => {
    const { target, temp, sessionId, workspace, kept } = await stoppedStagedRun();

    const ended = await cli(target, ['continue', sessionId, '--action', 'end-run']);
    expect(ended.exitCode, ended.stderr).toBe(0);

    expect(existsSync(workspace)).toBe(false);
    expect(sandboxTempFolders(temp).filter((name) => kept.includes(name))).toEqual([]);
  });

  it('removes them also when the project folder moved between the stop and End run', async () => {
    const { target, temp, sessionId, workspace, kept } = await stoppedStagedRun();
    const moved = { ...target, projectDir: join(target.tmpDir, 'moved-project') };
    renameSync(target.projectDir, moved.projectDir);
    const stage = join(sessionDir(moved.projectDir, sessionId), basename(dirname(workspace)));
    expect(existsSync(stage)).toBe(true);

    const ended = await cli(moved, ['continue', sessionId, '--action', 'end-run']);
    expect(ended.exitCode, ended.stderr).toBe(0);

    expect(existsSync(stage)).toBe(false);
    expect(sandboxTempFolders(temp).filter((name) => kept.includes(name))).toEqual([]);
  });
});

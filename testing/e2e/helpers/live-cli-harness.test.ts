import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCKFILE, sessionDir } from '../../../src/core/paths.js';
import { readRunnerPids, recordRunnerPid } from '../../../src/core/sessions/runner-pids.js';
import { canSignalProcess } from '../../../src/lib/process/liveness.js';
import { readProcessStartTimeMs } from '../../../src/lib/process/start-time.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { spawnCli } from './live-cli-harness.js';

const SESSION_ID = 'harness-teardown-sid';

let projectDir: string | undefined;
let runner: ChildProcess | undefined;

afterEach(() => {
  if (runner?.pid !== undefined) {
    try {
      process.kill(-runner.pid, 'SIGKILL');
    } catch {
      // The deadline teardown already reaped the runner's group.
    }
  }
  runner = undefined;
  if (projectDir !== undefined) cleanupTempDir(projectDir);
  projectDir = undefined;
});

describe('spawnCli deadline teardown', () => {
  it('reaps the fixture runner-pid ledger after the group kill', async () => {
    projectDir = createTempDir('live-cli-harness-teardown');
    // A runner tool in a group of its own, recorded in the session ledger the way
    // a live run records it. The deadline kill takes down the CLI's group only, so
    // this child outlives it unless the teardown reaps the ledger.
    runner = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pid = runner.pid;
    if (pid === undefined) throw new Error('the runner child reported no pid');

    const dir = sessionDir(projectDir, SESSION_ID);
    mkdirSync(dir, { recursive: true });
    // A dead owner (pid 40001 no longer exists), so the session's ledger is the
    // orphan reaper's to clear.
    writeFileSync(
      join(dir, LOCKFILE),
      JSON.stringify({
        version: 1,
        pid: 40001,
        startTimeMs: 1000,
        lastAliveMs: Date.now(),
        sessionId: SESSION_ID,
        mode: 'quick',
        feature: 'harness teardown',
      }),
    );
    const startTimeMs = readProcessStartTimeMs(pid);
    expect(startTimeMs).not.toBeNull();
    recordRunnerPid({ projectDir, sessionId: SESSION_ID }, pid, startTimeMs);
    expect(canSignalProcess(pid)).toBe(true);

    const outcome = await spawnCli({
      args: ['-e', 'setInterval(() => {}, 1000)'],
      stateHome: join(projectDir, 'state-home'),
      timeoutMs: 200,
      reapProjectDir: projectDir,
    });

    expect(outcome.exitCode).toBeNull();
    expect(canSignalProcess(pid)).toBe(false);
    expect(readRunnerPids({ projectDir, sessionId: SESSION_ID })).toEqual([]);
    runner = undefined;
  }, 30_000);
});

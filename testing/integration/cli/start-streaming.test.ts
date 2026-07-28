import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  fakeDeps,
  getStartCommandTmp,
  setupStartCommandIntegration,
  writeReadyReadinessFixtures,
} from '#testing/helpers/start-command.js';
import { registerStartCommand } from '../../../src/cli/commands/start/register.js';
import type { StartDeps } from '../../../src/cli/commands/start/types.js';
import { SPLITBRIEF_DIR, sessionDir } from '../../../src/core/paths.js';
import { runHeadless } from '../../../src/cli/headless.js';
import { readLockfile, checkServerStatus } from '../../../src/engine/ipc/lockfile.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';

setupStartCommandIntegration();

describe('start command — liveness record', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function onlySessionId(projectDir: string): string {
    const sessionsDir = join(projectDir, SPLITBRIEF_DIR, 'sessions');
    const ids = readdirSync(sessionsDir);
    expect(ids).toHaveLength(1);
    return ids[0] ?? '';
  }

  it('creates and then releases a liveness record across a real headless start run', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { validation: false, codebase: false });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let midRunPid: number | undefined;
    let midRunExitedAt: number | undefined;
    const planner = makePlanner({
      quickPlan: vi.fn().mockImplementation(async () => {
        const lock = await readLockfile(sessionDir(tmp, onlySessionId(tmp)));
        midRunPid = lock?.pid;
        midRunExitedAt = lock?.exitedAt;
        return {
          spec: '',
          plan: '',
          tasks: [],
          usage: { inputTokens: 50, outputTokens: 25 },
        };
      }),
    });
    const implementer = makeImplementer();

    const realHeadlessDeps: StartDeps = {
      ...fakeDeps,
      runHeadless: (options) =>
        runHeadless({ ...options, _planner: planner, _implementer: implementer }),
    };

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, realHeadlessDeps);
    await expect(
      program.parseAsync([
        'node',
        'splitbrief',
        'start',
        '--json',
        '--mode',
        'quick',
        'implement X',
        '--project',
        tmp,
      ]),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Workflow failed'),
    });

    const sessionId = onlySessionId(tmp);
    const dir = sessionDir(tmp, sessionId);

    expect(midRunPid).toBe(process.pid);
    expect(midRunExitedAt).toBeUndefined();

    let status = await checkServerStatus(dir);
    for (let i = 0; i < 50 && status.alive; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await checkServerStatus(dir);
    }
    expect(status.alive).toBe(false);
    const lock = await readLockfile(dir);
    expect(lock?.exitedAt).toBeDefined();
  });
});

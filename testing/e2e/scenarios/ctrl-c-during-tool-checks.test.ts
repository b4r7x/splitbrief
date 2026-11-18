import { expect, it } from 'vitest';
import { stopDuringToolCall } from '#testing/helpers/stop-during-tool-call.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

// A signed-in Command Code user starts a plain run and presses Ctrl+C while SPLITBRIEF still
// checks the sign-in. The terminal sends SIGINT to the whole foreground process group.
it('Ctrl+C on a plain start during the sign-in check exits 130 and leaves no copy of the sign-in file', async () => {
  await withTempDir('ctrl-c-tool-checks', async (dir) => {
    const stopped = await stopDuringToolCall(dir, {
      args: ['start', 'add a greeting', '--plain'],
      during: 'status',
      signal: 'SIGINT',
      to: 'group',
    });

    expect(stopped.signInCopiesBefore).toHaveLength(1);
    expect({ exitCode: stopped.exitCode, exitSignal: stopped.exitSignal }, stopped.stderr).toEqual({
      exitCode: 130,
      exitSignal: null,
    });
    expect({ stdout: stopped.stdout, stderr: stopped.stderr }).toEqual({ stdout: '', stderr: '' });
    expect(stopped.signInCopiesAfter).toEqual([]);
    expect(stopped.foldersAfter).toEqual([]);
    expect(stopped.toolRunning).toBe(false);
    expect(stopped.stopMs).toBeLessThan(30_000);
  });
});

it('Ctrl+C during a spec call exits 130 and removes the sandbox temp folder and sign-in copy', async () => {
  await withTempDir('ctrl-c-spec', async (dir) => {
    const stopped = await stopDuringToolCall(dir, {
      args: ['spec', 'add a greeting'],
      during: 'seat',
      signal: 'SIGINT',
      to: 'group',
      worker: 'drain',
    });

    expect(stopped.signInCopiesBefore).toHaveLength(1);
    expect(stopped.stdout).toMatch(/^Planning feature: add a greeting/);
    expect
      .soft({
        exitCode: stopped.exitCode,
        exitSignal: stopped.exitSignal,
        stderr: stopped.stderr,
      })
      .toEqual({ exitCode: 130, exitSignal: null, stderr: '' });
    expect.soft(stopped.foldersAfter).toEqual([]);
    expect.soft(stopped.signInCopiesAfter).toEqual([]);
  });
});

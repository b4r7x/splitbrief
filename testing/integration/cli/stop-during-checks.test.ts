import { describe, expect, it } from 'vitest';
import { stopDuringToolCall } from '#testing/helpers/stop-during-tool-call.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

// Each command checks its tools before any run starts. A signal there must stop the checks, end
// their tool processes and remove their folders, one of them a copy of the sign-in file, before
// SPLITBRIEF exits with the signal's code.
describe('a termination signal while the tools are checked', { timeout: 120_000 }, () => {
  it.each([
    {
      name: 'start --plain',
      args: ['start', 'fixture feature', '--plain'],
      signal: 'SIGINT',
      code: 130,
    },
    {
      name: 'start --json',
      args: ['start', 'fixture feature', '--json'],
      signal: 'SIGTERM',
      code: 143,
    },
    { name: 'doctor', args: ['doctor'], signal: 'SIGHUP', code: 129 },
  ] as const)(
    '$name on $signal removes the check folders and exits $code',
    async ({ args, signal, code }) => {
      await withTempDir('stop-during-checks', async (dir) => {
        const stopped = await stopDuringToolCall(dir, {
          args,
          during: 'status',
          signal,
          to: 'process',
        });

        expect(stopped.signInCopiesBefore).toHaveLength(1);
        expect(stopped.foldersBefore).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^splitbrief-readiness-/),
            expect.stringMatching(/^sb-/),
          ]),
        );
        expect(
          { exitCode: stopped.exitCode, exitSignal: stopped.exitSignal },
          stopped.stderr,
        ).toEqual({ exitCode: code, exitSignal: null });
        expect(stopped.foldersAfter).toEqual([]);
        expect(stopped.signInCopiesAfter).toEqual([]);
        expect(stopped.toolRunning).toBe(false);
        // The sign-in status call holds for 60 s before its check gives up.
        expect(stopped.stopMs).toBeLessThan(30_000);
        expect({ stdout: stopped.stdout, stderr: stopped.stderr }).toEqual({
          stdout: '',
          stderr: '',
        });
      });
    },
  );

  it('doctor on SIGINT during --help exits 130 without an error line', async () => {
    await withTempDir('stop-during-help', async (dir) => {
      const stopped = await stopDuringToolCall(dir, {
        args: ['doctor'],
        during: 'help',
        signal: 'SIGINT',
        to: 'process',
      });

      expect({
        exitCode: stopped.exitCode,
        exitSignal: stopped.exitSignal,
        stderr: stopped.stderr,
      }).toEqual({ exitCode: 130, exitSignal: null, stderr: '' });
      expect(stopped.foldersAfter).toEqual([]);
      expect(stopped.toolRunning).toBe(false);
    });
  });
});

describe('SIGINT during a paid call', { timeout: 120_000 }, () => {
  it.each([
    { command: 'doctor --probe-seat', args: ['doctor', '--probe-seat', 'plan'], worker: 'pipes' },
    { command: 'doctor --probe-seat', args: ['doctor', '--probe-seat', 'plan'], worker: 'drain' },
    { command: 'spec', args: ['spec', 'add a greeting'], worker: 'drain' },
    { command: 'review', args: ['review'], worker: 'drain' },
  ] as const)(
    '$command with $worker exits 130 and cleans up the call',
    async ({ command, args, worker }) => {
      await withTempDir('stop-during-seat', async (dir) => {
        const stopped = await stopDuringToolCall(dir, {
          args,
          during: 'seat',
          signal: 'SIGINT',
          to: 'process',
          worker,
        });

        expect(stopped.signInCopiesBefore).toHaveLength(1);
        expect(stopped.foldersBefore).toContainEqual(expect.stringMatching(/^sb-/));
        if (command === 'doctor --probe-seat') {
          expect(stopped.foldersBefore).toContainEqual(
            expect.stringMatching(/^splitbrief-cli-conformance-/),
          );
          expect.soft(stopped.stdout).toBe('');
          expect.soft(stopped.probeRecords).toEqual([]);
        }
        expect
          .soft({
            exitCode: stopped.exitCode,
            exitSignal: stopped.exitSignal,
            stderr: stopped.stderr,
          })
          .toEqual({ exitCode: 130, exitSignal: null, stderr: '' });
        expect.soft(stopped.foldersAfter).toEqual([]);
        expect.soft(stopped.signInCopiesAfter).toEqual([]);
        expect(stopped.toolRunning).toBe(false);
      });
    },
  );
});

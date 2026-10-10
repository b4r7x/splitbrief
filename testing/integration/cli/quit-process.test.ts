import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { terminalSequences } from '../../../src/lib/terminal/control.js';
import type { PtyExitEvent } from './pty/capability.js';
import { terminatePtyProcessGroup } from './pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from './pty/run.js';

it('exits after two Ctrl+C presses while an in-process discovery timer remains pending', async (context) => {
  await withTempDir('quit-process', async (dir) => {
    const result = await runWithPtyChild(
      {
        requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
        argv: ['--import', 'tsx', fileURLToPath(new URL('./pty/quit-child.ts', import.meta.url))],
        spawnOptions: {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: safeChildEnvironment(dir),
        },
      },
      async (child) => {
        const exited = Promise.withResolvers<PtyExitEvent>();
        let didExit = false;
        let rawIo = '';
        const exitListener = child.onExit((event) => {
          didExit = true;
          exited.resolve(event);
        });
        const dataListener = child.onData((data) => {
          rawIo += data;
        });
        try {
          await vi.waitFor(() => expect(rawIo).toContain('Quit discovery pending'), {
            timeout: 20_000,
          });
          child.write('\x03');
          await vi.waitFor(() => expect(rawIo).toContain('Press ctrl+c again to quit'));
          const quitAt = performance.now();
          child.write('\x03');
          await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 3_000 });
          expect(await exited.promise).toMatchObject({ exitCode: 0 });
          expect(performance.now() - quitAt).toBeLessThan(3_000);
          expect(rawIo.lastIndexOf(terminalSequences.exitAltBuffer)).toBeGreaterThan(
            rawIo.lastIndexOf(terminalSequences.enterAltBuffer),
          );
          expect(rawIo).toContain(terminalSequences.showCursor);
        } finally {
          try {
            if (!didExit) await terminatePtyProcessGroup(child, exited.promise);
          } finally {
            dataListener.dispose();
            exitListener.dispose();
          }
        }
      },
    );
    if (result) context.skip(result.reason);
  });
});

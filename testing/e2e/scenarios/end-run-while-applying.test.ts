import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { seedApplyingRun } from '../helpers/applying-run.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('End run during Apply recovery', () => {
  it.each(['partial', 'interrupted'] as const)(
    'refuses a %s Apply and preserves the checkout, workspace, backup and recovery',
    async (kind) => {
      const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
      fixture = target;
      const { ref, files, workspaceDir, backupDir, backup, statePath } = await seedApplyingRun(
        target,
        kind,
      );
      const before = readFileSync(statePath, 'utf8');
      const manifest = readFileSync(join(backupDir, 'manifest.json'), 'utf8');

      for (const json of [false, true]) {
        const ended = await cli(target, ['continue', ref.sessionId, '--action', 'end-run'], {
          json,
          timeoutMs: 60_000,
        });
        expect(ended.exitCode, ended.stderr).toBe(1);
        expect(ended.stderr).toContain('Restore or retry Apply first');
        expect(ended.stderr).not.toContain('saved in');
        if (json) {
          expect(JSON.parse(ended.stdout)).toEqual({
            type: 'error',
            message: 'Apply did not finish. Restore or retry Apply first, then end the run.',
          });
        } else {
          expect(ended.stdout).toBe('');
        }
      }

      expect(readFileSync(statePath, 'utf8')).toBe(before);
      expect(readFileSync(join(backupDir, 'manifest.json'), 'utf8')).toBe(manifest);
      for (const entry of backup.backup.replaced) {
        if (!('sha256' in entry)) throw new Error(`${entry.path} was backed up as a link`);
        expect(readFileSync(join(backupDir, 'blobs', entry.sha256), 'utf8')).toBe('before Apply\n');
      }
      expect(readFileSync(join(target.projectDir, 'a.txt'), 'utf8')).toBe('run result\n');
      expect(readFileSync(join(target.projectDir, 'b.txt'), 'utf8')).toBe('before Apply\n');
      for (const file of files)
        expect(readFileSync(join(workspaceDir, file), 'utf8')).toBe('run result\n');
      expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(false);
      expect(readActive(target.projectDir)).toBe(ref.sessionId);
    },
  );

  it.each(['partial', 'interrupted'] as const)(
    'offers no End run in Session options on a %s Apply opened at rest',
    async (kind) => {
      const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
      fixture = target;
      const { statePath } = await seedApplyingRun(target, kind);
      const before = readFileSync(statePath, 'utf8');
      const home = join(target.tmpDir, 'home');
      mkdirSync(home);
      const viewport = { cols: 120, rows: 40 };
      const result = await runWithPtyChild(
        {
          requirement: 'required',
          argv: ['--import', 'tsx', 'src/cli.ts', '--project', target.projectDir],
          spawnOptions: {
            name: 'xterm-256color',
            ...viewport,
            cwd: resolve(import.meta.dirname, '../../..'),
            env: { ...safeChildEnvironment(home), XDG_STATE_HOME: target.stateHome },
          },
        },
        async (child) => {
          const terminal = new XtermHeadless.Terminal({
            ...viewport,
            allowProposedApi: true,
            logLevel: 'off',
          });
          const exited = Promise.withResolvers<PtyExitEvent>();
          const screen = () =>
            Array.from(
              { length: viewport.rows },
              (_, row) =>
                terminal.buffer.active
                  .getLine(terminal.buffer.active.viewportY + row)
                  ?.translateToString(true) ?? '',
            ).join('\n');
          const data = child.onData((chunk) => terminal.write(chunk));
          const exit = child.onExit((event) => exited.resolve(event));
          const waitForText = (text: string) =>
            vi.waitFor(() => expect(screen()).toContain(text), { timeout: 30_000 });
          try {
            await waitForText('Describe your feature');
            child.write('/sessions');
            await waitForText('/sessions');
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);
            child.write('\r');
            await waitForText('Sessions · 1');
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);
            child.write('\r');
            await vi.waitFor(() => expect(screen()).not.toContain('Sessions · 1'), {
              timeout: 30_000,
            });
            child.write('/stop');
            await waitForText('/stop');
            await delay(PROMPT_TYPEAHEAD_GRACE_MS);
            child.write('\r');
            await waitForText('Session options');
            return screen();
          } finally {
            await terminatePtyProcessGroup(child, exited.promise);
            data.dispose();
            exit.dispose();
            terminal.dispose();
          }
        },
      );
      if (typeof result !== 'string') throw new Error(result.reason);
      expect(result).toContain('Resume ·');
      expect(result).toContain('Back to sessions ·');
      expect(result).not.toContain('End run ·');
      expect(readFileSync(statePath, 'utf8')).toBe(before);
    },
  );
});

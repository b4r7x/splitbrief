import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { seedApplyingRun } from '../helpers/applying-run.js';
import {
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let home: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  home?.restore();
  home = undefined;
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/**
 * While the hold file exists, the call that moves b.txt's temporary into place waits. The
 * preload writes the blocked file first, which is what the test waits on.
 */
function writeBlockingPreload(target: StopContinueFixture, holdPath: string, blockedPath: string) {
  const preload = join(target.tmpDir, 'apply-hold.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
globalThis.fetch = async () => { throw new Error('Network disabled in Apply E2E'); };
for (const call of ['link', 'rename']) {
  const original = fs[call];
  fs[call] = async (...args) => {
    const path = String(args[0]);
    if (dirname(path) === ${JSON.stringify(realpathSync(target.projectDir))} &&
        basename(path).startsWith('.b.txt.tmp.')) {
      writeFileSync(${JSON.stringify(blockedPath)}, String(process.pid));
      while (existsSync(${JSON.stringify(holdPath)})) await delay(50);
    }
    return original(...args);
  };
}
syncBuiltinESMExports();
`,
  );
  return preload;
}

// A run cut off inside Apply is continued and Re-run Apply runs live, in the process that drives
// the run. While it writes, the byline says so with its clock, and Escape waits for it rather than
// offering a stop.
it('says Apply is writing while a live Re-run Apply writes, and Esc goes home only once it finishes', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
  fixture = target;
  const { ref } = await seedApplyingRun(target, 'interrupted');
  home = useTrustHome('apply-live-home');
  await trustDeclaredRunners({
    projectDir: target.projectDir,
    config: loadConfig(target.projectDir).config,
  });
  const holdPath = join(target.tmpDir, 'hold-apply');
  const blockedPath = join(target.tmpDir, 'apply-blocked');
  writeFileSync(holdPath, '');
  const preload = writeBlockingPreload(target, holdPath, blockedPath);
  const viewport = { cols: 120, rows: 40 };
  const result = await runWithPtyChild(
    {
      requirement: 'required',
      argv: [
        '--import',
        preload,
        'dist/cli.js',
        'continue',
        ref.sessionId,
        '--allow-repo-runners',
        '--project',
        target.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        ...viewport,
        cwd: resolve(import.meta.dirname, '../../..'),
        env: { ...safeChildEnvironment(home.home), XDG_STATE_HOME: target.stateHome },
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
        await waitForText('Needs you · Apply stopped part way');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\r');
        await vi.waitFor(() => expect(existsSync(blockedPath), screen()).toBe(true), {
          timeout: 30_000,
        });
        await waitForText('Applying to your checkout');
        const applying = screen();
        child.write('\x1b');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\x1b');
        await delay(1_000);
        const held = screen();
        const heldState = readState(target, ref.sessionId);
        rmSync(holdPath);
        await vi.waitFor(
          () => {
            expect(screen()).toContain('Describe your feature');
            expect(screen()).toContain('applied');
          },
          { timeout: 30_000 },
        );
        return { applying, held, heldState };
      } finally {
        rmSync(holdPath, { force: true });
        await terminatePtyProcessGroup(child, exited.promise);
        data.dispose();
        exit.dispose();
        terminal.dispose();
      }
    },
  );
  if (!('applying' in result)) throw new Error(result.reason);
  const { applying, held, heldState } = result;

  expect(applying).toContain('/ for a command · ⏎ for home when Apply finishes…');
  expect(applying).not.toContain('esc stop options');
  expect(held).toContain('Applying to your checkout');
  expect(held).toContain('Returns home when Apply finishes');
  for (const screen of [applying, held]) {
    expect(screen).not.toContain('Stop now');
    expect(screen).not.toContain('End run');
    expect(screen).not.toContain('Session options');
    expect(screen).not.toContain('Stopping');
  }
  expect(heldState.closed).toBeUndefined();
  expect(readState(target, ref.sessionId).closed).toMatchObject({ as: 'applied' });
  expect(readFileSync(join(target.projectDir, 'b.txt'), 'utf8')).toBe('run result\n');
});

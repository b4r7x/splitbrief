import { readFileSync, writeFileSync } from 'node:fs';
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
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const APPLY_HALT_RAIL = '● Plan → ● Build → ● Review → ✗ Apply';

let fixture: StopContinueFixture | undefined;
let home: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  home?.restore();
  home = undefined;
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

// An Apply cut off part way is continued: the live run resumes into Apply,
// Apply halts, and Re-run Apply finishes it. Every header frame keeps the passed stages and Apply.
it('keeps the passed stages on the rail through an Apply halt and Re-run Apply', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
  fixture = target;
  const { ref } = await seedApplyingRun(target, 'interrupted');
  home = useTrustHome('apply-rerun-home');
  await trustDeclaredRunners({
    projectDir: target.projectDir,
    config: loadConfig(target.projectDir).config,
  });
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in Apply rail E2E'); };\n",
  );
  const viewport = { cols: 120, rows: 40 };
  const result = await runWithPtyChild(
    {
      requirement: 'required',
      argv: [
        '--import',
        offline,
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
      // Every rail the header paints while the run is live, read after each write lands.
      const rails: string[] = [];
      const data = child.onData((chunk) =>
        terminal.write(chunk, () => {
          const rail = screen().split('\n')[0] ?? '';
          if (rail.includes('Plan')) rails.push(rail);
        }),
      );
      const exit = child.onExit((event) => exited.resolve(event));
      const waitForText = (text: string) =>
        vi.waitFor(() => expect(screen()).toContain(text), { timeout: 30_000 });
      try {
        await waitForText('Needs you · Apply stopped part way');
        const panel = screen();
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\r');
        await waitForText('Applied');
        return { panel, rails, closed: screen() };
      } finally {
        await terminatePtyProcessGroup(child, exited.promise);
        data.dispose();
        exit.dispose();
        terminal.dispose();
      }
    },
  );
  if (!('panel' in result)) throw new Error(result.reason);
  const { panel, rails, closed } = result;

  expect(panel.split('\n')[0]).toContain(APPLY_HALT_RAIL);
  expect(panel).toContain('Re-run Apply');
  expect(panel).not.toContain('Try again');

  expect(rails.length).toBeGreaterThan(0);
  for (const rail of rails) expect(rail).toMatch(/● Plan → ● Build → ● Review → . Apply/);

  const transcript = closed.split('\n');
  const recoveryRows = transcript.filter((line) => /^\s*Recovery\s/.test(line));
  expect(recoveryRows).toEqual([expect.stringContaining('Re-run Apply → continued')]);
  const recoveryAt = transcript.findIndex((line) => /^\s*Recovery\s/.test(line));
  const following = transcript.slice(recoveryAt + 1).find((line) => line.trim() !== '');
  expect(following?.trim()).toBe('Run continued');

  expect(readFileSync(join(target.projectDir, 'b.txt'), 'utf8')).toBe('run result\n');
});

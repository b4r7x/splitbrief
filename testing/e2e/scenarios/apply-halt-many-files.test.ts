import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
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

const HEADING = 'Needs you · Apply stopped part way';
const RUN_FILES = [
  'a.txt',
  'b.txt',
  ...Array.from({ length: 1498 }, (_, index) => `item-${String(index).padStart(4, '0')}.json`),
];

let fixture: StopContinueFixture | undefined;
let home: ReturnType<typeof useTrustHome> | undefined;

afterEach(() => {
  home?.restore();
  home = undefined;
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

// An Apply of 1500 files cut off after the first one is continued and halts again with 1499
// files left: the halt panel paints at once and ↓ moves the selection at once.
it('paints the halt of an Apply cut off with 1499 files left and answers ↓ at once', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'staged-copy' });
  fixture = target;
  const { ref } = await seedApplyingRun(target, 'interrupted', RUN_FILES);
  home = useTrustHome('apply-halt-many-files-home');
  await trustDeclaredRunners({
    projectDir: target.projectDir,
    config: loadConfig(target.projectDir).config,
  });
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in Apply halt E2E'); };\n",
  );
  const viewport = { cols: 140, rows: 40 };
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
      const selectedRow = () =>
        screen()
          .split('\n')
          .find((line) => line.includes('▌')) ?? '';
      let panelAt: number | undefined;
      let movedAt: number | undefined;
      const data = child.onData((chunk) =>
        terminal.write(chunk, () => {
          if (panelAt === undefined && screen().includes(HEADING)) panelAt = Date.now();
          if (movedAt === undefined && selectedRow().includes('Restore backup')) {
            movedAt = Date.now();
          }
        }),
      );
      const exit = child.onExit((event) => exited.resolve(event));
      try {
        await vi.waitFor(() => expect(panelAt).toBeDefined(), { timeout: 60_000 });
        const panel = screen();
        const before = selectedRow();
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        const pressedAt = Date.now();
        child.write('\u001b[B');
        await vi.waitFor(() => expect(movedAt).toBeDefined(), { timeout: 60_000 });
        return { panel, before, panelAt, pressedAt, movedAt };
      } finally {
        await terminatePtyProcessGroup(child, exited.promise);
        data.dispose();
        exit.dispose();
        terminal.dispose();
      }
    },
  );
  if (!('panel' in result)) throw new Error(result.reason);
  const { events } = await readRunEvents(ref);
  const halted = events.find((event) => event.type === 'recovery_prompted');
  if (halted === undefined) throw new Error('Apply did not halt');

  expect(result.panel).toContain('+1492 more');
  expect(result.before).toContain('Re-run Apply');
  expect.soft((result.panelAt ?? Number.POSITIVE_INFINITY) - halted.ts).toBeLessThan(2000);
  expect((result.movedAt ?? Number.POSITIVE_INFINITY) - result.pressedAt).toBeLessThan(1000);
}, 180_000);

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { afterEach, expect, it, vi } from 'vitest';
import { writeEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { saveSummary } from '../../../src/core/sessions/io.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const AT = '2026-10-11T00:00:00.000Z';
const FEATURE = 'Add a word counter,\nas one task';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/**
 * An ended run asked in two lines, whose first final review failed on a required check, as the
 * pre-review check words it.
 */
function seedClosedRun(target: StopContinueFixture): void {
  const ref = { projectDir: target.projectDir, sessionId: 'closed-review' };
  saveState(ref, { ...createInitialState(FEATURE), closed: { as: 'ended', at: AT } });
  saveSummary(ref, {
    id: ref.sessionId,
    feature: FEATURE,
    startedAt: Date.parse(AT),
    completedAt: Date.parse(AT),
    stateVersion: 1,
    status: 'ended',
    summary: makeSummary({ feature: FEATURE, totalTasks: 1, completedByLocal: 1 }),
  });
  writeEvidenceLedger(ref, {
    version: 1,
    sessionId: ref.sessionId,
    feature: FEATURE,
    generatedAt: AT,
    tasks: [],
    validationSummary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
    reviews: [
      {
        scope: 'final',
        cycle: 0,
        outcome: 'fail',
        blocking: [
          { id: 'P1', text: 'No task changed it.\nRequired check K1 did not pass (fail)' },
        ],
        at: AT,
      },
      { scope: 'final', cycle: 1, outcome: 'pass', blocking: [], at: AT },
    ],
  });
}

it('keeps the lines of the task and of an earlier failed review finding apart in the closed block', async () => {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  fixture = target;
  seedClosedRun(target);
  const home = join(target.tmpDir, 'home');
  mkdirSync(home);
  const viewport = { cols: 120, rows: 40 };
  const result = await runWithPtyChild(
    {
      requirement: 'required',
      argv: ['dist/cli.js', '--project', target.projectDir],
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
      const waitForText = async (text: string) => {
        await vi.waitFor(() => expect(screen()).toContain(text), { timeout: 30_000 });
      };
      try {
        await waitForText('Describe your feature');
        child.write('/sessions');
        await waitForText('/sessions');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\r');
        await waitForText('Sessions · 1');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\r');
        await waitForText('P1 No task changed it.');
        return { value: screen() };
      } finally {
        await terminatePtyProcessGroup(child, exited.promise);
        data.dispose();
        exit.dispose();
        terminal.dispose();
      }
    },
  );
  if (!('value' in result)) throw new Error(result.reason);
  expect(result.value).toContain('Add a word counter, as one task');
  expect(result.value).toContain('Final review failed');
  expect(result.value).toContain('P1 No task changed it. Required check K1 did not pass (fail)');
});

import { renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { eventsStore } from '../../../src/stores/workflow/events/state.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, type renderFeature } from '#testing/helpers/ink.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { consultFailureHaltFixture, plan, startToHalt } from '../helpers/consult-failure-halt.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  createStopContinueFixture,
  endImplementerHold,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const STARTED_IN = 'This run started in';
const WHAT_TO_DO =
  'Move the project back to that folder and start SPLITBRIEF there to continue the run, or end the run.';
const MOVED_BYLINE = 'Move the project back or end the run';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => resetAllStores());

afterEach(async () => {
  ui?.unmount();
  ui = undefined;
  await settleOpenedRuns();
  resetAllStores();
  restorePath?.();
  restorePath = undefined;
  vi.unstubAllEnvs();
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
  trustHome?.restore();
  trustHome = undefined;
});

describe('e2e: the run screen of a run whose project folder moved', { timeout: 240_000 }, () => {
  it.each(['shop', 'acme-internal-billing-and-invoicing-service-v2-monorepo-workspace'])(
    'keeps the actions and records one refusal when Skip finds that %s moved',
    async (folder) => {
      ({ fixture, restorePath } = consultFailureHaltFixture(plan));
      const started = { ...fixture, projectDir: join(fixture.tmpDir, folder) };
      renameSync(fixture.projectDir, started.projectDir);
      await startToHalt(started);
      const moved = { ...fixture, projectDir: join(fixture.tmpDir, 'moved-project') };
      renameSync(started.projectDir, moved.projectDir);

      const opened = await openHaltedRun(moved, { heading: 'Seat down' });
      ui = opened.screen;
      const screen = opened.screen;
      terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
      await flushEffects();
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Skip brief');

      screen.stdin.write('s');

      await vi.waitFor(
        () => {
          const refusals = eventsStore
            .get()
            .events.filter((event) => event.type === 'recovery_action_failed');
          expect(refusals).toMatchObject([{ message: expect.stringContaining(`/${folder}.`) }]);
        },
        { timeout: 30_000 },
      );
      const narrow = stripAnsiStyles(screen.lastFrame());
      expect(narrow.split('\n').length, narrow).toBeLessThanOrEqual(24);
      for (const action of ['Try again', 'Skip brief', 'End run']) expect(narrow).toContain(action);

      terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
      await flushEffects();
      const wide = stripAnsiStyles(screen.lastFrame()).replace(/\s+/g, ' ');
      expect(wide.split(STARTED_IN)).toHaveLength(2);
      expect(wide).toContain(WHAT_TO_DO);
    },
  );

  it('shows where to continue and returns home on Enter when a run starts in the moved folder', async () => {
    trustHome = useTrustHome('moved-project-screen');
    fixture = createStopContinueFixture(undefined, { isolation: 'none' });
    const target = fixture;
    const parked = await startAndSignal(target, 'SIGINT', target.projectDir);
    expect(parked.exitCode).toBe(130);
    await endImplementerHold(target);
    const movedDir = join(target.tmpDir, 'moved-project');
    renameSync(target.projectDir, movedDir);
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(trustHome.home),
      XDG_STATE_HOME: target.stateHome,
    };
    await trustDeclaredRunners({
      projectDir: movedDir,
      config: loadConfig(movedDir).config,
      pathEnv: env.PATH ?? '',
    });
    const viewport = { cols: 120, rows: 40 };

    // The built CLI starts in the moved folder, as a user who moved the project starts it there.
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [join(REPO_ROOT, 'dist/cli.js'), 'continue', '--allow-repo-runners'],
        spawnOptions: { name: 'xterm-256color', ...viewport, cwd: movedDir, env },
      },
      async (child) => {
        const exit = Promise.withResolvers<PtyExitEvent>();
        let outcome: PtyExitEvent | undefined;
        const terminal = new XtermHeadless.Terminal({
          ...viewport,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const words = () =>
          Array.from(
            { length: viewport.rows },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          )
            .join(' ')
            .replace(/[\s│]+/g, ' ');
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          outcome = event;
          exit.resolve(event);
        });
        try {
          await expect.poll(words, { timeout: 120_000 }).toContain(MOVED_BYLINE);
          expect(words().split(STARTED_IN)).toHaveLength(2);
          expect(words()).toContain(WHAT_TO_DO);

          child.write('\r');
          await expect.poll(words, { timeout: 30_000 }).toContain('Describe your feature');
        } finally {
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(movedDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );
  });
});

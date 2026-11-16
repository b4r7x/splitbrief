import { renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
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

/**
 * The words of the rows between the footer rule and the composer box, on one line. The rules are
 * the rows that open in the first column; the box opens one column in, on either glyph tier.
 */
function footerText(frame: string): string {
  const lines = frame.split('\n');
  const rule = lines.findLastIndex((line) => /^[─-]/.test(line));
  const composer = lines.findIndex((line, index) => index > rule && /^ [╭+]/.test(line));
  return lines
    .slice(rule + 1, composer)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('e2e: the run screen of a run whose project folder moved', { timeout: 240_000 }, () => {
  it.each([
    ['shop', ['/shop.Move']],
    [
      'acme-internal-billing-and-invoicing-service-v2-monorepo-workspace',
      ['…/acme-internal-billing', 'monorepo-workspace.Move'],
    ],
  ])(
    'shows what to do about a Skip refused after the project folder %s moved in the footer at 80x24',
    async (folder, shownName) => {
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
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Skip task');

      screen.stdin.write('s');

      // The refusal reads the run's files before it answers, so the wait outlasts a loaded machine.
      await vi.waitFor(
        () => expect(footerText(stripAnsiStyles(screen.lastFrame()))).toContain(STARTED_IN),
        { timeout: 30_000 },
      );
      // The temp folder of the run gives its path any length; the path gives way to the words after it.
      const frame = stripAnsiStyles(screen.lastFrame());
      expect(footerText(frame), frame).toContain(WHAT_TO_DO);
      // The path keeps the name of the folder the run started in, cut in its middle when it is long.
      for (const part of shownName)
        expect(footerText(frame).replace(/\s+/g, ''), frame).toContain(part);
      expect(frame.split('\n').length, frame).toBeLessThanOrEqual(24);
      for (const action of ['Try again', 'Skip task', 'End run']) expect(frame).toContain(action);
    },
  );

  it('tells the user to start SPLITBRIEF in the first folder when a run continued in the moved folder stops, and again on Enter', async () => {
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
    // Two error cards fit the body at this size, so the second one is read beside the first.
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
          await expect.poll(words, { timeout: 120_000 }).toContain('Stopped by an error');
          expect(words()).toContain(STARTED_IN);
          expect(words()).toContain(WHAT_TO_DO);

          // Enter retries the step in the same moved folder, and the run stops on the same sentence.
          child.write('\r');
          await vi.waitFor(
            () => {
              const screen = words();
              expect(screen.split(WHAT_TO_DO).length - 1, screen).toBe(2);
              expect(screen, screen).toContain('Stopped by an error');
            },
            { timeout: 120_000, interval: 100 },
          );
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

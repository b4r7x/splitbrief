import { existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { wholeFrames } from '../helpers/whole-frames.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const STARTED_IN = 'This run started in';
const GONE = 'The project folder';
const MOVED_BYLINE = 'Move the project back or end the run';
const SIDEBAR_TITLE = 'Briefs 0/1';
const CORRECTION = 'keep the greeting short';

let fixture: StopContinueFixture | undefined;
let trustHome: ReturnType<typeof useTrustHome> | undefined;

afterEach(async () => {
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
  trustHome?.restore();
  trustHome = undefined;
});

describe('e2e: the run screen at rest when its project folder goes away', {
  timeout: 240_000,
}, () => {
  it('keeps the run visible after the folder moves, accepts only commands, and can continue from the original folder', async () => {
    trustHome = useTrustHome('project-folder-gone');
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
    // The sidebar takes a column only on a terminal wider than 120 columns.
    const viewport = { cols: 140, rows: 40 };

    // The user starts SPLITBRIEF in the moved folder, the run stops on the move, and the user moves
    // the project back as the screen says, with the screen still open.
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
        const screen = () =>
          new Promise<string>((done) =>
            terminal.write('', () =>
              done(
                Array.from(
                  { length: viewport.rows },
                  (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
                ).join('\n'),
              ),
            ),
          );
        const frames = wholeFrames((data) => terminal.write(data));
        const dataListener = child.onData(frames.feed);
        const exitListener = child.onExit((event) => {
          frames.flush();
          outcome = event;
          exit.resolve(event);
        });
        try {
          await expect.poll(screen, { timeout: 120_000 }).toContain(MOVED_BYLINE);
          expect(await screen()).toContain(STARTED_IN);

          renameSync(movedDir, target.projectDir);

          await expect
            .poll(
              async () => {
                const text = await screen();
                return text.includes(GONE) || text.includes('Saved state unreadable');
              },
              { timeout: 30_000 },
            )
            .toBe(true);
          const moved = await screen();
          expect(moved).not.toContain('Saved state unreadable');
          expect(moved).not.toContain('no events yet');
          expect(moved).toContain(STARTED_IN);
          expect(moved).toContain(MOVED_BYLINE);

          // /end answers with the same sentence, and the run stays on the screen.
          await expect.poll(screen, { timeout: 60_000 }).not.toContain(GONE);
          child.write('/end');
          await expect.poll(screen).toContain('› /end');
          child.write('\r');
          await expect.poll(screen, { timeout: 30_000 }).toContain(GONE);
          const ended = await screen();
          expect(ended).not.toContain('No active run to end.');
          expect(ended).toContain(STARTED_IN);
          expect(ended).toContain(MOVED_BYLINE);
          expect(outcome).toBeUndefined();
          expect(existsSync(movedDir)).toBe(false);

          // The sidebar command still works while the project folder is unavailable.
          await expect.poll(screen, { timeout: 60_000 }).not.toContain(GONE);
          expect(await screen()).toContain(SIDEBAR_TITLE);
          child.write('/sidebar');
          await expect.poll(screen).toContain('› /sidebar');
          child.write('\r');
          await expect.poll(screen, { timeout: 30_000 }).not.toContain(SIDEBAR_TITLE);
          expect(existsSync(movedDir)).toBe(false);
          child.write(CORRECTION);
          await expect.poll(screen, { timeout: 30_000 }).toContain('Only /commands here');
          expect(await screen()).not.toContain(CORRECTION);
          expect(await screen()).toContain(STARTED_IN);
          expect(existsSync(movedDir)).toBe(false);

          child.write('\r');
          await expect.poll(screen, { timeout: 30_000 }).toContain('Describe your feature');
          expect(existsSync(movedDir)).toBe(false);
        } finally {
          if (outcome === undefined) await terminatePtyProcessGroup(child, exit.promise);
          await reapOrphanRunners(target.projectDir);
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );

    const finished = await continueRun(target);
    expect(finished.exitCode, finished.stderr).toBe(0);
    expect(readState(target, parked.sessionId).tasks.map((task) => task.status)).toEqual(['done']);
  });
});

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';
import type { SeatWait } from '../../../src/core/schemas/workflow.js';
import {
  createSessionLogAppender,
  toEngineEventEntry,
} from '../../../src/core/sessions/log-writer.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { acquireLiveness } from '../../../src/engine/orchestrator/run/liveness.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: the run screen of a run another process holds, while that run waits on a seat', () => {
  it('drops the wait once its reset passes, though the log never ends it', {
    timeout: 90_000,
  }, async () => {
    const target = createStopContinueFixture(() => '');
    fixture = target;
    const ref = { projectDir: target.projectDir, sessionId: 'held-wait' };
    saveState(ref, {
      ...createInitialState('Wait on Codex'),
      ...RUN_CREW,
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', status: 'in_progress' })],
    });
    // This test process holds the run and heartbeats, so the screen reads it as running.
    const release = await acquireLiveness({ ...ref, feature: 'Wait on Codex' });
    const home = join(target.tmpDir, 'home');
    mkdirSync(home);
    const viewport = { cols: 120, rows: 40 };
    try {
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
          const waitForText = async (text: string) => {
            await vi.waitFor(() => expect(screen()).toContain(text), { timeout: 30_000 });
          };
          try {
            await waitForText('Describe your feature');
            child.write('/sessions');
            await waitForText('/sessions');
            child.write('\r');
            await waitForText('Sessions · 1');
            child.write('\r');
            await waitForText('Running in another process');
            // The holder logs a wait on the open screen and never logs its end.
            const wait: SeatWait = {
              seat: 'build',
              resetAt: new Date(Date.now() + 4_000).toISOString(),
              tool: 'codex',
              kind: 'cli',
              holds: { tool: 'codex', kind: 'cli' },
            };
            createSessionLogAppender(ref)(
              toEngineEventEntry({
                type: 'seat_wait_started',
                ts: Date.now(),
                phase: 'implementing',
                seat: wait.seat,
                resetAt: wait.resetAt,
                tool: 'OpenAI Codex CLI',
                wait,
              }),
            );
            await waitForText('Waiting for OpenAI Codex CLI');
            const waiting = screen();
            await vi.waitFor(
              () => {
                const frame = screen();
                expect(frame).toContain('Running in another process');
                expect(frame).not.toContain('Waiting for');
              },
              { timeout: 15_000 },
            );
            return { value: { waiting, passedAt: Date.now(), resetAt: wait.resetAt } };
          } finally {
            await terminatePtyProcessGroup(child, exited.promise);
            data.dispose();
            exit.dispose();
            terminal.dispose();
          }
        },
      );
      if (!('value' in result)) throw new Error(result.reason);
      // The PTY child runs in UTC, so the local clock of the reset is its UTC hour and minute.
      const clock = result.value.resetAt.slice(11, 16);
      expect(result.value.waiting).toMatch(
        new RegExp(`Waiting for OpenAI Codex CLI · resets .*${clock}`),
      );
      expect(result.value.waiting).not.toContain('Running in another process');
      expect(result.value.passedAt).toBeGreaterThanOrEqual(Date.parse(result.value.resetAt));
      const log = readFileSync(
        join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE),
        'utf-8',
      );
      expect(log).not.toContain('seat_wait_ended');
    } finally {
      await release();
    }
  });
});

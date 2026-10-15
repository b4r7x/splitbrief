import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, expect, it } from 'vitest';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { steeringPaths } from '../helpers/steer-e2e-shims.js';
import {
  buildSteeringCli,
  readSteeringCaptures,
  readSteeringLog,
  runSteeringCli,
  STEERING_WAIT,
} from '../helpers/steer-e2e-workflow.js';
import { cli } from '../helpers/stop-continue-fixture.js';

/** How long the steered call works before the stop: long enough to tell its stretch apart. */
const STEERED_WORK_MS = 1_500;

beforeAll(buildSteeringCli, 120_000);

it('counts the stretch a steer continued in process when the brief later stops and continues', async () => {
  await runSteeringCli(
    { kind: 'cli', tool: 'claude-code', model: 'sonnet', contextLength: 200_000 },
    async ({ target, child, terminal, outcome }) => {
      const paths = steeringPaths(target.tmpDir, 'claude-code');
      await expect.poll(() => existsSync(paths.started), STEERING_WAIT).toBe(true);
      const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
      if (sessionId === undefined) throw new Error('BUILD started without a run session');
      const ref = { projectDir: target.projectDir, sessionId };
      const calls = () =>
        readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'call');
      const stops = () =>
        readSteeringLog(target.projectDir, sessionId).filter(
          (entry) => entry.kind === 'event' && entry.type === 'turn_interrupted',
        );
      await expect
        .poll(
          () =>
            readSteeringLog(target.projectDir, sessionId).some(
              (entry) =>
                entry.kind === 'event' &&
                entry.type === 'steerable_call' &&
                entry.taskId === 'T001' &&
                entry.data.seat === 'build',
            ),
          STEERING_WAIT,
        )
        .toBe(true);

      child.write('STEERED_BRIEF_TIME keep the greeting');
      await expect.poll(() => terminal(), STEERING_WAIT).toContain('STEERED_BRIEF_TIME');
      child.write('\x1b[13;5u');
      await expect.poll(() => calls(), STEERING_WAIT).toHaveLength(2);
      await delay(STEERED_WORK_MS);

      child.write('\x03');
      await expect.poll(() => stops(), STEERING_WAIT).toHaveLength(2);
      child.write('\x03');
      await expect.poll(() => outcome(), STEERING_WAIT).toBeDefined();

      writeFileSync(paths.release, '');
      const continued = await cli(target, ['continue', sessionId]);
      expect(continued.exitCode, `${continued.stdout}\n${continued.stderr}`).toBe(0);
      expect(loadState(ref)?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
      expect(calls()).toHaveLength(3);

      const { events } = await readRunEvents(ref);
      const starts = events.flatMap((event) => (event.type === 'task_started' ? [event.ts] : []));
      const buildCalls = events.flatMap((event) =>
        event.type === 'runner_call_started' && event.role === 'implementer' ? [event.ts] : [],
      );
      const cuts = events.flatMap((event) => (event.type === 'turn_interrupted' ? [event] : []));
      const done = events.find((event) => event.type === 'task_completed');
      const [firstStart, restart] = starts;
      const [, steeredCall] = buildCalls;
      const [steerCut, stop] = cuts;
      if (
        firstStart === undefined ||
        restart === undefined ||
        steeredCall === undefined ||
        steerCut === undefined ||
        stop === undefined ||
        done?.type !== 'task_completed'
      ) {
        throw new Error('expected a brief steered, stopped, continued and completed');
      }
      expect(steerCut).toMatchObject({ at: 'mid-step', step: { kind: 'brief', taskId: 'T001' } });
      expect(stop).toMatchObject({ at: 'mid-step', step: { kind: 'brief', taskId: 'T001' } });

      // Before the steer, the steered call up to the stop, and the stretch after Continue; the
      // pause before the steered call and the time the run sat stopped are left out.
      const beforeContinue = steerCut.ts - firstStart + (stop.ts - steeredCall);
      expect(stop.ts - steeredCall).toBeGreaterThanOrEqual(STEERED_WORK_MS);
      expect(done.duration).toBeGreaterThanOrEqual(beforeContinue);
      expect(done.duration).toBeLessThanOrEqual(beforeContinue + (done.ts - restart));
      expect(readEvidenceLedger(ref)?.tasks[0]?.durationMs).toBe(done.duration);
    },
  );
}, 240_000);

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, beforeAll, it } from 'vitest';
import { sessionsRoot } from '../../../src/core/paths.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../src/core/queue-state.js';
import { readSessionSummary } from '../../../src/core/sessions/run-record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { GREET_SOURCE } from '../helpers/stop-continue-fixture.js';
import { steeringPaths } from '../helpers/steer-e2e-shims.js';
import {
  buildSteeringCli,
  readSteeringCaptures,
  readSteeringLog,
  runSteeringCli,
  STEERING_WAIT,
} from '../helpers/steer-e2e-workflow.js';

beforeAll(buildSteeringCli, 120_000);

it.each(['claude-code', 'opencode'] as const)(
  'delivers a BUILD message through %s native steering before the call finishes',
  async (tool) => {
    const message = `MID_CALL_BUILD_${tool}`;
    await runSteeringCli(
      {
        kind: 'cli',
        tool,
        model: tool === 'claude-code' ? 'sonnet' : 'anthropic/claude-sonnet-4-6',
        contextLength: 200_000,
      },
      async ({ target, child, terminal, outcome }) => {
        const paths = steeringPaths(target.tmpDir, tool);
        await expect.poll(() => existsSync(paths.started), STEERING_WAIT).toBe(true);
        const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
        if (sessionId === undefined) throw new Error('BUILD started without a run session');
        expect(loadState({ projectDir: target.projectDir, sessionId })?.phase).toBe('implementing');
        await expect.poll(() => terminal(), STEERING_WAIT).toContain('Message BUILD on T001');
        await expect
          .poll(
            () =>
              readSteeringLog(target.projectDir, sessionId).some(
                (entry) =>
                  entry.kind === 'event' &&
                  entry.type === 'steerable_call' &&
                  entry.data.seat === 'build',
              ),
            STEERING_WAIT,
          )
          .toBe(true);
        child.write(message);
        await expect.poll(() => terminal(), STEERING_WAIT).toContain(message);
        child.write('\r');
        await expect
          .poll(
            () => readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'steer'),
            STEERING_WAIT,
          )
          .toHaveLength(1);
        const liveCaptures = readSteeringCaptures(target.tmpDir);
        const call = liveCaptures.find((entry) => entry.kind === 'call');
        expect(call).toMatchObject({ tool });
        expect(liveCaptures.find((entry) => entry.kind === 'steer')).toMatchObject({
          tool,
          text: expect.stringContaining(message),
          pid: call?.pid,
          channel: tool === 'claude-code' ? 'stdin' : 'http',
          beforeFinish: true,
        });
        expect(liveCaptures.some((entry) => entry.kind === 'finished')).toBe(false);
        expect(existsSync(paths.finished)).toBe(false);
        await expect
          .poll(
            () =>
              readSteeringLog(target.projectDir, sessionId).some(
                (entry) =>
                  entry.kind === 'event' &&
                  entry.type === 'queue_drained' &&
                  entry.data.via === 'mid-call',
              ),
            STEERING_WAIT,
          )
          .toBe(true);
        const liveState = loadState({ projectDir: target.projectDir, sessionId });
        expect(liveState?.phase).toBe('implementing');
        expect(liveState?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
        expect(liveState?.messageQueue).toMatchObject([
          { deliveredMidCall: true, deliveredTo: { implementer: expect.any(String) } },
        ]);
        expect(existsSync(paths.finished)).toBe(false);
        writeFileSync(paths.release, '');
        await expect
          .poll(
            () =>
              readSteeringLog(target.projectDir, sessionId).some(
                (entry) => entry.kind === 'event' && entry.type === 'workflow_complete',
              ),
            STEERING_WAIT,
          )
          .toBe(true);
        const state = loadState({ projectDir: target.projectDir, sessionId });
        expect(state?.phase).toBe('complete');
        expect(state?.reviewStatus).toBe('passed');
        expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
        expect(state?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
        const log = readSteeringLog(target.projectDir, sessionId);
        const queuedIndex = log.findIndex(
          (entry) => entry.kind === 'event' && entry.type === 'message_queued',
        );
        const drainedIndex = log.findIndex(
          (entry) => entry.kind === 'event' && entry.type === 'queue_drained',
        );
        const queuedId = state?.messageQueue[0]?.id;
        expect(log[queuedIndex]).toMatchObject({
          taskId: 'T001',
          data: { id: queuedId, seat: 'build', steerable: true },
        });
        expect(drainedIndex).toBeGreaterThan(queuedIndex);
        expect(log[drainedIndex]).toMatchObject({
          taskId: 'T001',
          data: { ids: [queuedId], count: 1, seat: 'build', via: 'mid-call' },
        });
        const captures = readSteeringCaptures(target.tmpDir);
        expect(captures.filter((entry) => entry.kind === 'call')).toHaveLength(1);
        expect(captures.filter((entry) => entry.kind === 'finished')).toHaveLength(1);
        expect(captures.filter((entry) => entry.kind === 'steer')).toHaveLength(1);
        expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
        expect(readdirSync(sessionsRoot(target.projectDir))).toEqual([sessionId]);
        child.write('\x11');
        await expect.poll(() => outcome(), STEERING_WAIT).toBeDefined();
        expect(outcome()?.exitCode, terminal()).toBe(0);
      },
    );
  },
);

/** How long the call a ctrl+⏎ restarted works before it ends: long enough to tell apart. */
const AFTER_SEND_MS = 1_500;

// RC6 run C: a 2m 41s run read `Ran 1m 20s`; the time after the interrupt-and-send was lost.
it('counts the run time after a ctrl+⏎ interrupt-and-send in Ran', async () => {
  await runSteeringCli(
    { kind: 'cli', tool: 'claude-code', model: 'sonnet', contextLength: 200_000 },
    async ({ target, child, terminal, outcome }) => {
      const paths = steeringPaths(target.tmpDir, 'claude-code');
      await expect.poll(() => existsSync(paths.started), STEERING_WAIT).toBe(true);
      const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
      if (sessionId === undefined) throw new Error('BUILD started without a run session');
      const log = () => readSteeringLog(target.projectDir, sessionId);
      const eventTs = (type: string): number[] =>
        log().flatMap((entry) =>
          entry.kind === 'event' && entry.type === type ? [Date.parse(entry.ts)] : [],
        );
      await expect
        .poll(
          () =>
            log().some(
              (entry) =>
                entry.kind === 'event' &&
                entry.type === 'steerable_call' &&
                entry.data.seat === 'build',
            ),
          STEERING_WAIT,
        )
        .toBe(true);

      child.write('RAN_AFTER_SEND keep the greeting');
      await expect.poll(() => terminal(), STEERING_WAIT).toContain('RAN_AFTER_SEND');
      child.write('\x1b[13;5u');
      await expect
        .poll(
          () => readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'call'),
          STEERING_WAIT,
        )
        .toHaveLength(2);
      await delay(AFTER_SEND_MS);
      writeFileSync(paths.release, '');
      await expect.poll(() => eventTs('workflow_complete'), STEERING_WAIT).toHaveLength(1);

      const [started] = eventTs('workflow_started');
      const [cut] = eventTs('turn_interrupted');
      const [complete] = eventTs('workflow_complete');
      if (started === undefined || cut === undefined || complete === undefined) {
        throw new Error('expected a run started, cut by the send and completed');
      }
      const restarted = eventTs('runner_call_started').find((ts) => ts >= cut);
      if (restarted === undefined) throw new Error('the send continued the run with no call');
      // The send continues the cut call: the run itself never stopped, so it publishes no resume.
      expect(eventTs('workflow_resumed')).toEqual([]);
      // The stretch before the cut, and at least the time the restarted call worked after it.
      const ranAtLeast = cut - started + AFTER_SEND_MS;
      expect(complete - restarted).toBeGreaterThanOrEqual(AFTER_SEND_MS);
      const ran = (): number | null =>
        readSessionSummary({ projectDir: target.projectDir, sessionId })?.activeTime ?? null;
      await expect.poll(ran, STEERING_WAIT).toBeGreaterThanOrEqual(ranAtLeast);
      child.write('\x11');
      await expect.poll(() => outcome(), STEERING_WAIT).toBeDefined();
      expect(outcome()?.exitCode, terminal()).toBe(0);
    },
  );
}, 240_000);

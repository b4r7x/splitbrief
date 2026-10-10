import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../src/core/queue-state.js';
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

const MESSAGE = 'BUILD_MESSAGE_FOR_FALLBACK_ONLY';

beforeAll(buildSteeringCli, 120_000);

it('steers the fallback BUILD tool after an account refusal without delivering to the old tool', async () => {
  await runSteeringCli(
    {
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-5-codex',
      contextLength: 200_000,
      fallback: { tool: 'claude-code', model: 'sonnet' },
    },
    async ({ target, child, terminal, outcome }) => {
      const paths = steeringPaths(target.tmpDir, 'claude-code');
      await expect.poll(() => existsSync(paths.started), STEERING_WAIT).toBe(true);
      const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
      if (sessionId === undefined) throw new Error('Fallback started without a run session');
      const ref = { projectDir: target.projectDir, sessionId };
      const switched = loadState(ref);
      expect(switched?.phase).toBe('implementing');
      expect(switched?.pendingRecovery).toBeUndefined();
      expect(switched?.seatSwitches).toEqual([
        expect.objectContaining({
          seat: 'build',
          from: expect.stringContaining('OpenAI Codex'),
          to: expect.stringContaining('Claude Code'),
          cause: 'runner-usage-limit',
          auto: true,
        }),
      ]);
      const primaryCaptures = readSteeringCaptures(target.tmpDir).filter(
        (entry) => entry.tool === 'codex',
      );
      expect(primaryCaptures.filter((entry) => entry.kind === 'call')).toHaveLength(1);
      expect(primaryCaptures.find((entry) => entry.kind === 'refusal')).toMatchObject({
        text: 'Insufficient Balance',
      });
      expect(existsSync(steeringPaths(target.tmpDir, 'codex').finished)).toBe(true);
      await expect.poll(() => terminal(), STEERING_WAIT).toContain('Message BUILD on T001');
      await expect
        .poll(
          () =>
            readSteeringLog(target.projectDir, sessionId).filter(
              (entry) =>
                entry.kind === 'event' &&
                entry.type === 'steerable_call' &&
                entry.data.seat === 'build',
            ),
          STEERING_WAIT,
        )
        .toHaveLength(1);
      child.write(MESSAGE);
      await expect.poll(() => terminal(), STEERING_WAIT).toContain(MESSAGE);
      child.write('\r');
      await expect
        .poll(
          () => readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'steer'),
          STEERING_WAIT,
        )
        .toHaveLength(1);
      const fallbackCall = readSteeringCaptures(target.tmpDir).find(
        (entry) => entry.kind === 'call' && entry.tool === 'claude-code',
      );
      expect(
        readSteeringCaptures(target.tmpDir).find((entry) => entry.kind === 'steer'),
      ).toMatchObject({
        tool: 'claude-code',
        pid: fallbackCall?.pid,
        text: expect.stringContaining(MESSAGE),
        channel: 'stdin',
        beforeFinish: true,
      });
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
      const liveState = loadState(ref);
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
      const state = loadState(ref);
      expect(state?.phase).toBe('complete');
      expect(state?.reviewStatus).toBe('passed');
      expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
      expect(state?.seatSwitches).toEqual(switched?.seatSwitches);
      expect(state?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
      const log = readSteeringLog(target.projectDir, sessionId);
      const switchedIndex = log.findIndex(
        (entry) => entry.kind === 'event' && entry.type === 'seat_switched',
      );
      const queuedIndex = log.findIndex(
        (entry) => entry.kind === 'event' && entry.type === 'message_queued',
      );
      const drainedIndex = log.findIndex(
        (entry) => entry.kind === 'event' && entry.type === 'queue_drained',
      );
      expect(switchedIndex).toBeGreaterThanOrEqual(0);
      expect(queuedIndex).toBeGreaterThan(switchedIndex);
      expect(drainedIndex).toBeGreaterThan(queuedIndex);
      const queuedId = state?.messageQueue[0]?.id;
      expect(log[queuedIndex]).toMatchObject({
        taskId: 'T001',
        data: { id: queuedId, seat: 'build', steerable: true },
      });
      expect(log[drainedIndex]).toMatchObject({
        taskId: 'T001',
        data: { ids: [queuedId], count: 1, seat: 'build', via: 'mid-call' },
      });
      const captures = readSteeringCaptures(target.tmpDir);
      expect(captures.filter((entry) => entry.tool === 'codex')).toEqual(primaryCaptures);
      expect(
        captures.filter((entry) => entry.tool === 'claude-code' && entry.kind === 'call'),
      ).toHaveLength(1);
      expect(captures.filter((entry) => entry.kind === 'steer')).toHaveLength(1);
      expect(
        captures.filter(
          (entry) => entry.tool === 'codex' && 'text' in entry && entry.text.includes(MESSAGE),
        ),
      ).toHaveLength(0);
      expect(loadConfig(target.projectDir).config.implementer).toMatchObject({
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
      });
      expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
      expect(readdirSync(sessionsRoot(target.projectDir))).toEqual([sessionId]);
      child.write('\x11');
      await expect.poll(() => outcome(), STEERING_WAIT).toBeDefined();
      expect(outcome()?.exitCode, terminal()).toBe(0);
    },
  );
});

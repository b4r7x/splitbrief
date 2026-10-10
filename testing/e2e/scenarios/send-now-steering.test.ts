import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { sessionsRoot } from '../../../src/core/paths.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../src/core/queue-state.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { canSignalProcess } from '../../../src/lib/process/liveness.js';
import { steeringPaths } from '../helpers/steer-e2e-shims.js';
import {
  buildSteeringCli,
  readSteeringCaptures,
  readSteeringLog,
  runSteeringCli,
  STEERING_WAIT,
} from '../helpers/steer-e2e-workflow.js';
import { GREET_SOURCE } from '../helpers/stop-continue-fixture.js';

beforeAll(buildSteeringCli, 120_000);

it('stops BUILD on Ctrl+Enter and continues the same brief with the full message and attachment', async () => {
  const message =
    'SEND_NOW_BUILD_CORRECTION Keep the greeting API and both empty-name and named greetings. Preserve the run marker.';
  const attachment =
    '# Send now requirements\n\nRead every requirement in this attached file.\nKeep greet synchronous and return a string.\nSEND_NOW_ATTACHMENT_FINAL_LINE\n';
  await runSteeringCli(
    { kind: 'cli', tool: 'claude-code', model: 'sonnet', contextLength: 200_000 },
    async ({ target, child, terminal, outcome }) => {
      const paths = steeringPaths(target.tmpDir, 'claude-code');
      await expect.poll(() => existsSync(paths.started), STEERING_WAIT).toBe(true);
      const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
      if (sessionId === undefined) throw new Error('BUILD started without a run session');
      const before = loadState({ projectDir: target.projectDir, sessionId });
      expect(before?.phase).toBe('implementing');
      expect(before?.tasks).toMatchObject([{ id: 'T001', status: 'in_progress' }]);
      await expect.poll(() => terminal(), STEERING_WAIT).toContain('Message BUILD on T001');
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
      const first = readSteeringCaptures(target.tmpDir).find((entry) => entry.kind === 'call');
      if (first === undefined) throw new Error('BUILD started without a captured prompt');
      expect(canSignalProcess(first.pid)).toBe(true);
      expect(first.text).not.toContain(message);
      expect(first.text).not.toContain(attachment);
      const attachmentPath = join(realpathSync(target.tmpDir), 'send-now-note.md');
      writeFileSync(attachmentPath, attachment);
      child.write(`${message} @${attachmentPath}`);
      await expect.poll(() => terminal(), STEERING_WAIT).toContain('send-now-note.md');
      child.write('\x1b[13;5u');
      await expect.poll(() => canSignalProcess(first.pid), STEERING_WAIT).toBe(false);
      await expect
        .poll(() => readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'call'), {
          ...STEERING_WAIT,
          message: 'Ctrl+Enter stopped T001 but did not continue it',
        })
        .toHaveLength(2);
      const calls = readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'call');
      const continued = calls[1];
      if (continued === undefined) throw new Error('The stopped brief did not continue');
      expect(continued.tool).toBe(first.tool);
      expect(continued.pid).not.toBe(first.pid);
      expect(continued.text).toContain(message);
      expect(continued.text).toContain(attachmentPath);
      expect(continued.text).toContain(attachment.trim());
      expect(canSignalProcess(continued.pid)).toBe(true);
      expect(readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'steer')).toEqual(
        [],
      );
      expect(existsSync(paths.finished)).toBe(false);
      const log = readSteeringLog(target.projectDir, sessionId);
      expect(
        log.find((entry) => entry.kind === 'event' && entry.type === 'turn_interrupted'),
      ).toMatchObject({
        phase: 'implementing',
        data: { source: 'user', at: 'mid-step', step: { kind: 'brief', taskId: 'T001' } },
      });
      const buildCalls = log.filter(
        (entry) =>
          entry.kind === 'event' &&
          entry.type === 'runner_call_started' &&
          entry.data.role === 'implementer',
      );
      expect(buildCalls).toHaveLength(2);
      for (const call of buildCalls) {
        expect(call).toMatchObject({
          phase: 'implementing',
          taskId: 'T001',
          data: { runnerName: 'claude-code', model: 'sonnet' },
        });
      }
      const liveState = loadState({ projectDir: target.projectDir, sessionId });
      expect(liveState?.phase).toBe('implementing');
      expect(liveState?.tasks).toMatchObject([{ id: 'T001', status: 'in_progress' }]);
      expect(liveState?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
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
      expect(readFileSync(target.greetPath, 'utf8')).toBe(GREET_SOURCE);
      expect(readdirSync(sessionsRoot(target.projectDir))).toEqual([sessionId]);
      expect(
        readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'call'),
      ).toHaveLength(2);
      expect(
        readSteeringCaptures(target.tmpDir).filter((entry) => entry.kind === 'finished'),
      ).toHaveLength(1);
      child.write('\x11');
      await expect.poll(() => outcome(), STEERING_WAIT).toBeDefined();
      expect(outcome()?.exitCode, terminal()).toBe(0);
    },
  );
});

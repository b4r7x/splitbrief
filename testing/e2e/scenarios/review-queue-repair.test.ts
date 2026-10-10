import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { sessionsRoot } from '../../../src/core/paths.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../src/core/queue-state.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  readReviewVerdictCalls,
  runReviewVerdictCli,
} from '../helpers/review-verdict-steer-workflow.js';
import {
  buildSteeringCli,
  readSteeringLog,
  STEERING_WAIT as WAIT,
} from '../helpers/steer-e2e-workflow.js';

const CORRECTION = 'REVIEW_MESSAGE_FOR_VERDICT_REPAIR';

beforeAll(buildSteeringCli, 120_000);

it.each([false, true])(
  'delivers a queued REVIEW message to its one verdict repair with valid repair=%s',
  async (validRepair) => {
    await runReviewVerdictCli(
      [
        'invalid verdict',
        validRepair
          ? JSON.stringify(
              passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] }),
            )
          : 'invalid repair verdict',
      ],
      async ({ target, started, release, child, terminal, outcome }) => {
        await expect
          .poll(() => existsSync(started), { ...WAIT, message: 'REVIEW never started' })
          .toBe(true);
        const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
        if (sessionId === undefined) throw new Error('REVIEW started without a run session');
        const ref = { projectDir: target.projectDir, sessionId };
        expect(loadState(ref)?.phase).toBe('final-review');
        await expect.poll(() => terminal(), WAIT).toContain('Message REVIEW');
        child.write(CORRECTION);
        await expect.poll(() => terminal(), WAIT).toContain(CORRECTION);
        child.write('\r');
        await expect
          .poll(
            () =>
              readSteeringLog(target.projectDir, sessionId).some(
                (entry) => entry.kind === 'event' && entry.type === 'message_queued',
              ),
            WAIT,
          )
          .toBe(true);
        expect(
          loadState(ref)?.messageQueue.filter(isQueuedMessagePendingFirstDelivery),
        ).toHaveLength(1);
        expect(readReviewVerdictCalls(target.tmpDir)).toHaveLength(1);
        writeFileSync(release, '');
        await expect
          .poll(
            () =>
              validRepair
                ? loadState(ref)?.phase === 'complete'
                : loadState(ref)?.pendingRecovery?.reason === 'seat-protocol-error',
            { ...WAIT, message: 'Run did not settle after the verdict repair' },
          )
          .toBe(true);
        const state = loadState(ref);
        expect(state?.messageQueue).toHaveLength(1);
        expect(state?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
        expect(state?.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
        expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
        const log = readSteeringLog(target.projectDir, sessionId);
        const queuedIndex = log.findIndex(
          (entry) => entry.kind === 'event' && entry.type === 'message_queued',
        );
        const drainedIndex = log.findIndex(
          (entry) => entry.kind === 'event' && entry.type === 'queue_drained',
        );
        expect(drainedIndex).toBeGreaterThan(queuedIndex);
        expect(log[queuedIndex]).toMatchObject({ data: { seat: 'review' } });
        expect(log[drainedIndex]).toMatchObject({
          data: { seat: 'review', count: 1, ids: [state?.messageQueue[0]?.id] },
        });
        expect(
          log.filter((entry) => entry.kind === 'event' && entry.type === 'queue_drained'),
        ).toHaveLength(1);
        expect(
          log.filter((entry) => entry.kind === 'event' && entry.type === 'review_completed'),
        ).toMatchObject([{ data: { verdict: validRepair ? 'pass' : 'no-verdict' } }]);
        const calls = readReviewVerdictCalls(target.tmpDir);
        expect(calls).toHaveLength(2);
        expect(calls[0]?.prompt).not.toContain(CORRECTION);
        expect(calls[1]?.prompt).toContain(CORRECTION);
        expect(calls[1]?.prompt).toContain('It failed validation:');
        expect(calls[1]?.cwd).toBe(calls[0]?.cwd);
        expect(readdirSync(sessionsRoot(target.projectDir))).toEqual([sessionId]);
        child.write('\x11');
        await expect
          .poll(() => outcome(), { ...WAIT, message: 'Quit did not exit after cleanup' })
          .toBeDefined();
        expect(outcome()?.exitCode, terminal()).toBe(0);
      },
    );
  },
);

import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { sessionsRoot } from '../../../src/core/paths.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../src/core/queue-state.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { canSignalProcess } from '../../../src/lib/process/liveness.js';
import { failedReviewVerdict, passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  readReviewVerdictCalls,
  runReviewVerdictCli,
} from '../helpers/review-verdict-steer-workflow.js';
import {
  buildSteeringCli,
  readSteeringLog,
  STEERING_WAIT as WAIT,
} from '../helpers/steer-e2e-workflow.js';
import { GREET_FILE } from '../helpers/stop-continue-fixture.js';

beforeAll(buildSteeringCli, 120_000);

it('replaces a held valid failing REVIEW verdict after a queued correction and attachment, then completes with the second verdict', async () => {
  const message =
    'REVIEW_VERDICT_CORRECTION Use the attached acceptance criteria for the final verdict. The current greeting satisfies them. Preserve both declared files.';
  const attachment =
    '# Review acceptance criteria\n\nThe empty name must return hello. A named greeting must return hello followed by one space and the name.\nThe greeting must stay synchronous and the run marker must stay unchanged.\nREVIEW_ATTACHMENT_FINAL_LINE\n';
  const firstVerdict = failedReviewVerdict(
    'Task ids: T001\nCriterion ids: C1',
    'The greeting requires clarification of its acceptance criteria.',
    { taskId: 'T001', file: GREET_FILE, criterionId: 'C1' },
  );
  await runReviewVerdictCli(
    [
      JSON.stringify(firstVerdict),
      JSON.stringify(passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] })),
    ],
    async ({ target, started, release, child, terminal, outcome }) => {
      await expect
        .poll(() => existsSync(started), { ...WAIT, message: 'First verdict never started' })
        .toBe(true);
      const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
      if (sessionId === undefined) throw new Error('REVIEW started without a run session');
      const ref = { projectDir: target.projectDir, sessionId };
      expect(loadState(ref)?.phase).toBe('final-review');
      const first = readReviewVerdictCalls(target.tmpDir)[0];
      if (first === undefined) throw new Error('First verdict prompt was not captured');
      expect(first.prompt).not.toContain(message);
      expect(first.prompt).not.toContain(attachment.trim());
      await expect.poll(() => terminal(), WAIT).toContain('Message REVIEW');
      const attachmentPath = join(realpathSync(target.tmpDir), 'review-verdict-steer-note.md');
      writeFileSync(attachmentPath, attachment);
      child.write(`${message} @${attachmentPath}`);
      await expect.poll(() => terminal(), WAIT).toContain('review-verdict-steer-note.md');
      child.write('\r');
      await expect
        .poll(
          () =>
            readSteeringLog(target.projectDir, sessionId).filter(
              (entry) => entry.kind === 'event' && entry.type === 'message_queued',
            ),
          WAIT,
        )
        .toHaveLength(1);
      const queuedState = loadState(ref);
      expect(queuedState?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(1);
      expect(queuedState?.messageQueue[0]?.deliveredTo?.reviewer).toBeUndefined();
      const heldLog = readSteeringLog(target.projectDir, sessionId);
      expect(
        heldLog.filter((entry) => entry.kind === 'event' && entry.type === 'queue_drained'),
      ).toHaveLength(0);
      expect(
        heldLog.find((entry) => entry.kind === 'event' && entry.type === 'message_queued'),
      ).not.toMatchObject({ data: { steerable: true } });
      expect(readReviewVerdictCalls(target.tmpDir)).toHaveLength(1);
      expect(canSignalProcess(first.pid)).toBe(true);
      writeFileSync(release, '');
      await expect
        .poll(
          () =>
            readSteeringLog(target.projectDir, sessionId).some(
              (entry) => entry.kind === 'event' && entry.type === 'review_completed',
            ),
          { ...WAIT, message: 'REVIEW did not publish a verdict' },
        )
        .toBe(true);
      const calls = readReviewVerdictCalls(target.tmpDir);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.prompt).toContain(message);
      expect(calls[1]?.prompt).toContain(attachmentPath);
      expect(calls[1]?.prompt).toContain(attachment.trim());
      expect(calls[1]?.prompt).not.toContain('It failed validation:');
      expect(calls[1]?.cwd).toBe(first.cwd);
      await expect
        .poll(() => loadState(ref)?.phase, {
          ...WAIT,
          message: 'Second verdict did not complete the run',
        })
        .toBe('complete');
      const state = loadState(ref);
      expect(state?.reviewStatus).toBe('passed');
      expect(state?.review).toMatchObject({ outcome: 'pass', verdict: { findings: [] } });
      expect(state?.pendingRecovery).toBeUndefined();
      expect(state?.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
      expect(state?.tasks).toHaveLength(1);
      expect(state?.messageQueue).toHaveLength(1);
      expect(state?.messageQueue.filter(isQueuedMessagePendingFirstDelivery)).toHaveLength(0);
      expect(state?.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
      expect(state?.messageQueue[0]?.deliveredMidCall).not.toBe(true);
      const log = readSteeringLog(target.projectDir, sessionId);
      const queuedIndex = log.findIndex(
        (entry) => entry.kind === 'event' && entry.type === 'message_queued',
      );
      const drainedIndex = log.findIndex(
        (entry) => entry.kind === 'event' && entry.type === 'queue_drained',
      );
      expect(drainedIndex).toBeGreaterThan(queuedIndex);
      expect(log[queuedIndex]).toMatchObject({
        data: { seat: 'review', id: state?.messageQueue[0]?.id },
      });
      expect(log[drainedIndex]).toMatchObject({
        data: { seat: 'review', count: 1, ids: [state?.messageQueue[0]?.id] },
      });
      expect(log[drainedIndex]).not.toMatchObject({ data: { via: 'mid-call' } });
      expect(
        log.filter((entry) => entry.kind === 'event' && entry.type === 'queue_drained'),
      ).toHaveLength(1);
      expect(
        log.filter((entry) => entry.kind === 'event' && entry.type === 'review_completed'),
      ).toMatchObject([{ data: { verdict: 'pass' } }]);
      await expect
        .poll(
          () =>
            readSteeringLog(target.projectDir, sessionId).filter(
              (entry) => entry.kind === 'event' && entry.type === 'workflow_complete',
            ),
          WAIT,
        )
        .toMatchObject([{ data: { review: 'passed' } }]);
      expect(readdirSync(sessionsRoot(target.projectDir))).toEqual([sessionId]);
      child.write('\x11');
      await expect.poll(() => outcome(), WAIT).toBeDefined();
      expect(outcome()?.exitCode, terminal()).toBe(0);
    },
  );
});

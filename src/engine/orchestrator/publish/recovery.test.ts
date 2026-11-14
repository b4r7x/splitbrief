import { describe, it, expect } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { TASK } from '#testing/helpers/publish-task.js';
import { parseEngineEvent } from '../../events/schema.js';
import {
  publishRecoveryActionFailed,
  publishRecoveryActionSelected,
  publishRecoveryPrompted,
  publishRecoveryResolved,
} from './recovery.js';

describe('recovery events carry headline spans', () => {
  it.each(['plan', 'build', 'review'] as const)(
    'records headline spans for a %s halt without an unused prompt seat',
    (seat) => {
      const { bus, events } = makeBusRecorder();
      const issue = makeRecoveryIssue({
        reason: 'planner-call-failed',
        seat,
        phase: 'implementing',
      });
      const at = { kind: 'brief', taskId: TASK, attempt: 0 } as const;
      publishRecoveryPrompted({ bus, phase: issue.phase }, 'session', issue, at, false);
      expect(events[0]).toMatchObject({ type: 'recovery_prompted', issue, at });
      expect(events[0]).not.toHaveProperty('seat');
      expect(parseEngineEvent(events[0])).not.toHaveProperty('seat');
      expect(parseEngineEvent(events[0])).toMatchObject({
        headlineSpans: [
          {
            text: seat === 'review' ? 'Reviewer' : 'Planner',
            seat: seat === 'review' ? 'review' : 'plan',
          },
          { text: ' call failed' },
        ],
      });
    },
  );

  function publishAll(issue: ReturnType<typeof makeRecoveryIssue>) {
    const { bus, events } = makeBusRecorder();
    const opts = { bus, phase: issue.phase, issue, action: 'switch-seat' } as const;
    publishRecoveryActionSelected(opts);
    publishRecoveryActionFailed({ ...opts, message: 'blocked' });
    publishRecoveryResolved({ ...opts, outcome: 'continued' });
    return events;
  }

  it('carries the seat the swap offer moves', () => {
    const events = publishAll(
      makeRecoveryIssue({
        reason: 'runner-usage-limit',
        phase: 'planning',
        seat: 'plan',
        switchSeat: { seat: 'plan', candidates: [{ tool: 'codex' }] },
      }),
    );

    expect(events.map((event) => ('seat' in event ? event.seat : undefined))).toEqual([
      'plan',
      'plan',
      'plan',
    ]);
  });

  it('falls back to the seat the issue names when it offers no swap', () => {
    const events = publishAll(makeRecoveryIssue({ seat: 'review' }));

    expect(events.map((event) => ('seat' in event ? event.seat : undefined))).toEqual([
      'review',
      'review',
      'review',
    ]);
  });

  it('omits the seat when the halt is about the run rather than a seat', () => {
    const events = publishAll(makeRecoveryIssue());

    expect(events).toHaveLength(3);
    for (const event of events) expect(event).not.toHaveProperty('seat');
  });
});

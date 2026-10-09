import { describe, expect, it, vi } from 'vitest';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { Reviewer } from '../../reviewers/types.js';
import type { PlannerOutputCallbacks, TypedCallContext } from '../../planners/types.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { createBusTextHandler } from '../events.js';
import { withPlannerCallPublishing, withReviewerCallPublishing } from './call-publishing.js';

const TYPED_ANSWER = '{"id":"V3","command":"npm test","declined":[]}';

/** A typed call that streams its whole answer through the seat's text callback. */
function streamingTypedCall(ctx: TypedCallContext): TypedSeatCall {
  return {
    seat: ctx.seat,
    typedOutput: 'fallback',
    canResume: false,
    invoke: async () => {
      ctx.callbacks.onOutput(TYPED_ANSWER);
      return makeRunnerCallResult({ status: 'completed', text: TYPED_ANSWER });
    },
  };
}

function streamingReviewer(): Reviewer {
  return {
    review: async (_prompt: string, _projectDir: string, callbacks: PlannerOutputCallbacks) => {
      callbacks.onOutput('### Verdict\npass\n');
      return { text: '### Verdict\npass\n', usage: null };
    },
    typedCall: streamingTypedCall,
  };
}

describe('call publishing', () => {
  it('streams no text from a wrapped reviewer typed call', async () => {
    const { bus, events } = makeBusRecorder();
    const reviewer = withReviewerCallPublishing(streamingReviewer(), {
      bus,
      getPhase: () => 'final-review',
    });

    await reviewer
      .typedCall({
        projectDir: '/project',
        seat: 'reviewer',
        callbacks: { onOutput: createBusTextHandler({ bus, phase: 'final-review' }) },
      })
      .invoke({ prompt: 'plan the checks' });

    expect(events.filter((event) => event.type === 'planner_text')).toHaveLength(0);
  });

  it('streams no text from a wrapped planner typed call', async () => {
    const { bus, events } = makeBusRecorder();
    const planner = withPlannerCallPublishing(makePlanner({ typedCall: streamingTypedCall }), {
      bus,
      getPhase: () => 'final-review',
    });

    await planner
      .typedCall({
        projectDir: '/project',
        seat: 'reviewer',
        callbacks: { onOutput: createBusTextHandler({ bus, phase: 'final-review' }) },
      })
      .invoke({ prompt: 'plan the checks' });

    expect(events.filter((event) => event.type === 'planner_text')).toHaveLength(0);
  });

  it('keeps the caller onCallEvent on a typed call', () => {
    const { bus } = makeBusRecorder();
    const onCallEvent = vi.fn();
    let received: PlannerOutputCallbacks | undefined;
    const reviewer = withReviewerCallPublishing(
      {
        ...streamingReviewer(),
        typedCall: (ctx) => {
          received = ctx.callbacks;
          return streamingTypedCall(ctx);
        },
      },
      { bus, getPhase: () => 'final-review' },
    );

    reviewer.typedCall({
      projectDir: '/project',
      seat: 'reviewer',
      callbacks: { onOutput: () => {}, onCallEvent },
    });

    expect(received?.onCallEvent).toBe(onCallEvent);
  });

  it('still streams the text of a wrapped reviewer review call', async () => {
    const { bus, events } = makeBusRecorder();
    const reviewer = withReviewerCallPublishing(streamingReviewer(), {
      bus,
      getPhase: () => 'final-review',
    });

    await reviewer.review('review the diff', '/project', {
      onOutput: createBusTextHandler({ bus, phase: 'final-review' }),
    });

    expect(
      events.filter((event) => event.type === 'planner_text' && event.text.includes('pass')),
    ).toHaveLength(1);
  });
});

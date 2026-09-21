import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRewindHandler } from './rewind-handler.js';
import type { ResumeHydration } from './resume-hydration.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { feedbackStore } from '../../stores/ui/feedback.js';

const prepared = {
  session: { ref: { projectDir: '/tmp/nowhere', sessionId: 'rewind-handler-test' } },
} as unknown as PreparedExecution;

function handlerFor(hydrated: ResumeHydration) {
  const controller = new AbortController();
  const setPendingRewind = vi.fn();
  const onRewound = vi.fn();
  const resetMode = vi.fn();
  const handler = buildRewindHandler({
    prepared,
    controller,
    hydrate: () => hydrated,
    resetMode,
    setPendingRewind,
    onRewound,
  });
  return { handler, controller, setPendingRewind, onRewound, resetMode };
}

afterEach(() => {
  feedbackStore.reset();
});

describe('buildRewindHandler', () => {
  it('resets input mode and does nothing else when no state is saved', () => {
    const { handler, controller, setPendingRewind, onRewound, resetMode } = handlerFor({
      kind: 'missing',
    });

    handler({ target: 'spec' });

    expect(resetMode).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);
    expect(setPendingRewind).not.toHaveBeenCalled();
    expect(onRewound).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).toBeNull();
  });

  it('surfaces the resume failure and aborts nothing when the state is invalid', () => {
    const { handler, controller, onRewound } = handlerFor({
      kind: 'invalid',
      code: 'malformed',
      message: 'bad json',
    });

    handler({ target: 'spec' });

    expect(feedbackStore.get().message).toBe('Cannot resume: bad json');
    expect(controller.signal.aborted).toBe(false);
    expect(onRewound).not.toHaveBeenCalled();
  });
});

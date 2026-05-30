import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { createTuiSink } from '../../../src/features/workflow/tui-sink.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions.js';
import { makeErrorEvent } from '#testing/helpers/events.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';

type ErrorEvent = Extract<EngineEvent, { type: 'error' }>;

function isErrorEvent(event: EngineEvent | undefined): event is ErrorEvent {
  return event?.type === 'error';
}

describe('error event → UI propagation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkflow();
    feedbackStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('engine error events reach the events store via bus', () => {
    it('engine emits error event → eventsStore contains the error', () => {
      const bus = createEventBus();
      bus.subscribe(createTuiSink());

      const errorEvent = makeErrorEvent({ message: 'Model context exceeded' });
      bus.publish(errorEvent);

      const events = eventsStore.get().events;
      const last = events.at(-1);
      if (!isErrorEvent(last)) throw new Error('expected last event to be an error event');
      expect(last.message).toBe('Model context exceeded');
    });

    it('multiple error events accumulate in the events store in order', () => {
      const bus = createEventBus();
      bus.subscribe(createTuiSink());

      bus.publish(makeErrorEvent({ message: 'first error', ts: 1 }));
      bus.publish(makeErrorEvent({ message: 'second error', ts: 2 }));
      bus.publish(makeErrorEvent({ message: 'third error', ts: 3 }));

      const errors = eventsStore.get().events.filter(isErrorEvent);
      expect(errors).toHaveLength(3);
      expect(errors[0]?.message).toBe('first error');
      expect(errors[1]?.message).toBe('second error');
      expect(errors[2]?.message).toBe('third error');
    });

    it('warning events also reach the events store', () => {
      const bus = createEventBus();
      bus.subscribe(createTuiSink());

      const warningEvent: EngineEvent = {
        type: 'warning',
        ts: Date.now(),
        phase: 'implementing',
        message: 'Rate limit approaching',
      };
      bus.publish(warningEvent);

      const warnings = eventsStore.get().events.filter((e) => e.type === 'warning');
      expect(warnings).toHaveLength(1);
    });
  });

  describe('feedbackStore shows user-action errors', () => {
    it('setError persists and does not auto-clear', () => {
      feedbackStore.setError('Cannot attach: session not found');

      expect(feedbackStore.get().message).toBe('Cannot attach: session not found');
      expect(feedbackStore.get().isError).toBe(true);

      vi.advanceTimersByTime(10_000);
      expect(feedbackStore.get().message).toBe('Cannot attach: session not found');
      expect(feedbackStore.get().isError).toBe(true);
    });

    it('setMessage auto-clears after timeout', () => {
      feedbackStore.setMessage('Config saved');

      expect(feedbackStore.get().message).toBe('Config saved');
      expect(feedbackStore.get().isError).toBe(false);

      vi.advanceTimersByTime(3000);
      expect(feedbackStore.get().message).toBeNull();
    });

    it('a later setError replaces a pending setMessage', () => {
      feedbackStore.setMessage('saved');
      feedbackStore.setError('Connection lost');

      expect(feedbackStore.get().message).toBe('Connection lost');
      expect(feedbackStore.get().isError).toBe(true);

      // The auto-clear timer from setMessage should not fire
      vi.advanceTimersByTime(5000);
      expect(feedbackStore.get().message).toBe('Connection lost');
    });
  });
});

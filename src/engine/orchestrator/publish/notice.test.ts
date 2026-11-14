import { describe, it, expect } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { publishError, publishWarning } from './notice.js';

describe('publish* payload forwarding', () => {
  it('publishError — forwards message and timestamp', () => {
    const { bus, events } = makeBusRecorder();
    publishError({ bus: bus, phase: 'implementing', message: 'something went wrong' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'something went wrong' });
    expect((events[0] as { ts: number }).ts).toBeGreaterThan(0);
  });

  it('publishWarning — carries explicit operational warning safety metadata', () => {
    const { bus, events } = makeBusRecorder();
    publishWarning({
      bus: bus,
      phase: 'implementing',
      message: 'Queue full (50 messages).',
      safety: {
        category: 'queue',
        code: 'queue_full',
      },
    });

    const warning = events[0];
    if (warning === undefined) {
      expect(warning).toBeDefined();
      return;
    }

    expect(warning).toMatchObject({
      type: 'warning',
      message: 'Queue full (50 messages).',
      category: 'queue',
      code: 'queue_full',
    });
  });
});

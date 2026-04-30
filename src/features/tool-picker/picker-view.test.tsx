import { beforeEach, describe, expect, it } from 'vitest';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { refreshPickerDetection } from './picker-view.js';

describe('refreshPickerDetection', () => {
  beforeEach(() => {
    feedbackStore.reset();
  });

  it('replaces the in-progress refresh message after refresh succeeds', async () => {
    await refreshPickerDetection('/tmp/project', async () => {});

    expect(feedbackStore.get()).toEqual({
      message: 'Models refreshed',
      isError: false,
    });
  });

  it('surfaces refresh failures instead of leaving stale progress feedback', async () => {
    await refreshPickerDetection('/tmp/project', async () => {
      throw new Error('provider offline');
    });

    const feedback = feedbackStore.get();
    expect(feedback.isError).toBe(true);
    expect(feedback.message).toContain('provider offline');
  });
});

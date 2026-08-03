import { beforeEach, describe, expect, it } from 'vitest';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { refreshPickerDetection } from './picker-view.js';
import type {
  DiscoveryRefreshStatus,
  DiscoveryRefreshSummary,
} from '../../core/runtime/commands/types.js';

function refreshSummary(status: DiscoveryRefreshStatus): DiscoveryRefreshSummary {
  switch (status) {
    case 'fresh':
      return {
        status,
        published: true,
        lanes: {
          readiness: { outcome: 'fresh' },
          modelsDev: { outcome: 'fresh' },
          cliModels: { outcome: 'fresh' },
        },
      };
    case 'partial':
      return {
        status,
        published: true,
        lanes: {
          readiness: { outcome: 'fresh' },
          modelsDev: { outcome: 'failed' },
          cliModels: { outcome: 'fresh' },
        },
      };
    case 'stale':
      return {
        status,
        published: true,
        lanes: {
          readiness: { outcome: 'stale' },
          modelsDev: { outcome: 'failed' },
          cliModels: { outcome: 'stale' },
        },
      };
    case 'failed':
      return {
        status,
        published: true,
        lanes: {
          readiness: { outcome: 'failed' },
          modelsDev: { outcome: 'failed' },
          cliModels: { outcome: 'failed' },
        },
      };
    case 'not-run':
      return {
        status,
        published: false,
        lanes: {
          readiness: { outcome: 'not-run', reason: 'offline' },
          modelsDev: { outcome: 'not-run', reason: 'offline' },
          cliModels: { outcome: 'not-run', reason: 'offline' },
        },
      };
    case 'uninitialized':
      return {
        status,
        published: false,
        lanes: {
          readiness: { outcome: 'not-run', reason: 'uninitialized' },
          modelsDev: { outcome: 'not-run', reason: 'uninitialized' },
          cliModels: { outcome: 'not-run', reason: 'uninitialized' },
        },
      };
    case 'superseded':
      return {
        status,
        published: false,
        lanes: {
          readiness: { outcome: 'not-run', reason: 'superseded' },
          modelsDev: { outcome: 'not-run', reason: 'superseded' },
          cliModels: { outcome: 'not-run', reason: 'superseded' },
        },
      };
  }
}

describe('refreshPickerDetection', () => {
  beforeEach(() => {
    feedbackStore.reset();
    modelCacheStore.reset();
  });

  it('replaces the in-progress refresh message after refresh succeeds', async () => {
    await refreshPickerDetection('/tmp/project', async () => {
      expect(feedbackStore.get()).toEqual({
        message: 'Refreshing models…',
        isError: false,
      });
      return {
        status: 'fresh',
        published: true,
        lanes: {
          readiness: { outcome: 'fresh' },
          modelsDev: { outcome: 'fresh' },
          cliModels: { outcome: 'fresh' },
        },
      };
    });

    expect(feedbackStore.get()).toEqual({
      message: 'Models refreshed',
      isError: false,
    });
  });

  it.each([
    ['partial', 'Models refresh completed with partial results'],
    ['stale', 'Models refresh kept stale results'],
    ['failed', 'Models refresh failed'],
    ['not-run', 'Models refresh was not run'],
    ['uninitialized', 'Models refresh is not initialized'],
    ['superseded', 'Models refresh was superseded'],
  ] as const)('does not claim success when the refresh is %s', async (status, message) => {
    await refreshPickerDetection('/tmp/project', async () => refreshSummary(status));

    expect(feedbackStore.get()).toEqual({ message, isError: true });
  });

  it('reports a first-ever all-lane failure without claiming that prior results were retained', async () => {
    await refreshPickerDetection('/tmp/project', async () => refreshSummary('failed'));
    expect(feedbackStore.get()).toEqual({ message: 'Models refresh failed', isError: true });
  });

  it('reports a same-context overlapping refresh as superseded without inventing a settings change', async () => {
    const firstRefresh = Promise.withResolvers<DiscoveryRefreshSummary>();
    const secondRefresh = Promise.withResolvers<DiscoveryRefreshSummary>();
    const feedbacks: Array<{ message: string | null; isError: boolean }> = [];
    const stopObserving = feedbackStore.subscribe(() => feedbacks.push(feedbackStore.get()));

    const first = refreshPickerDetection('/tmp/project', async () => firstRefresh.promise);
    const second = refreshPickerDetection('/tmp/project', async () => secondRefresh.promise);
    firstRefresh.resolve(refreshSummary('superseded'));
    await first;
    secondRefresh.resolve(refreshSummary('fresh'));
    await second;
    stopObserving();

    expect(feedbacks).toContainEqual({ message: 'Models refresh was superseded', isError: true });
    expect(feedbackStore.get()).toEqual({ message: 'Models refreshed', isError: false });
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

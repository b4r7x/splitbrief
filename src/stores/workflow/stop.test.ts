import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stopStore } from './stop.js';

describe('stopStore', () => {
  beforeEach(() => {
    stopStore.__testReset();
  });

  it('request → park → resume returns to idle and calls the resolver with the steer text', () => {
    const resolve = vi.fn();

    stopStore.request('stop-now');
    expect(stopStore.get().intent).toBe('stop-now');
    expect(stopStore.get().phase).toBe('requested');
    expect(stopStore.get().requestedAt).not.toBeNull();

    stopStore.park('mid-brief', 'T001', resolve);
    expect(stopStore.get().phase).toBe('parked');
    expect(stopStore.get().parked).toMatchObject({ kind: 'mid-brief', taskId: 'T001' });

    stopStore.resume('use the other adapter');

    expect(resolve).toHaveBeenCalledExactlyOnceWith('use the other adapter');
    expect(stopStore.get()).toEqual({
      intent: 'none',
      phase: 'idle',
      requestedAt: null,
      parked: null,
    });
  });

  it('walks requested → terminating → forcing → ended', () => {
    stopStore.request('quit');
    stopStore.markTerminating();
    expect(stopStore.get().phase).toBe('terminating');
    stopStore.markForcing();
    expect(stopStore.get().phase).toBe('forcing');
    stopStore.end();
    expect(stopStore.get()).toMatchObject({ intent: 'quit', phase: 'ended', parked: null });
  });

  it('a boundary pause parks on the brief it stopped after and resumes into the next one', () => {
    const resolve = vi.fn();

    stopStore.request('pause-after-brief');
    stopStore.park('boundary', 'T001', resolve);

    expect(stopStore.get().phase).toBe('parked');
    expect(stopStore.get().parked).toMatchObject({ kind: 'boundary', taskId: 'T001' });

    stopStore.resume('');

    expect(resolve).toHaveBeenCalledExactlyOnceWith('');
    expect(stopStore.get().phase).toBe('idle');
    expect(stopStore.get().intent).toBe('none');
  });

  it('parks a boundary pause with no resolver and resumes without throwing', () => {
    stopStore.request('pause-after-brief');
    stopStore.park('boundary', null, null);
    stopStore.resume('');
    expect(stopStore.get().phase).toBe('idle');
  });
});

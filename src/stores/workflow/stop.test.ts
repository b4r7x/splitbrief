import { plainUserMessage } from '../../core/types/user-input.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as stopModule from './stop.js';
import { stopStore, type StopIntent, type StopPhase } from './stop.js';

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

    stopStore.resume(plainUserMessage('use the other adapter'));

    expect(resolve).toHaveBeenCalledExactlyOnceWith(plainUserMessage('use the other adapter'));
    expect(stopStore.get()).toEqual({
      intent: 'none',
      phase: 'idle',
      requestedAt: null,
      parked: null,
      seatChange: false,
    });
  });

  it('a seat change waits beside a pause and goes with a stop', () => {
    stopStore.markSeatChange(true);
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: true });

    stopStore.request('pause-after-brief');
    expect(stopStore.get()).toMatchObject({ intent: 'pause-after-brief', seatChange: true });

    stopStore.request('stop-now');
    expect(stopStore.get()).toMatchObject({ intent: 'stop-now', seatChange: false });
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

    stopStore.resume(plainUserMessage(''));

    expect(resolve).toHaveBeenCalledExactlyOnceWith(plainUserMessage(''));
    expect(stopStore.get().phase).toBe('idle');
    expect(stopStore.get().intent).toBe('none');
  });

  it('leaves a resolverless park for saved-state continuation', () => {
    stopStore.request('pause-after-brief');
    stopStore.park('boundary', null, null);
    expect(stopStore.resume(plainUserMessage(''))).toBe(false);
    expect(stopStore.get().phase).toBe('parked');
  });

  it('does not resolve a park while the workflow is stopping', () => {
    const resolve = vi.fn();
    stopStore.park('boundary', 'T001', resolve);
    stopStore.request('stop-now');

    expect(stopStore.resume(plainUserMessage(''))).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(stopStore.get().phase).toBe('requested');
  });
});

describe('stopInProgress', () => {
  const INTENTS: readonly StopIntent[] = [
    'none',
    'stop-now',
    'pause-after-brief',
    'end-run',
    'quit',
  ];
  const PHASES: readonly StopPhase[] = [
    'idle',
    'requested',
    'terminating',
    'forcing',
    'settling',
    'parked',
    'ended',
    'failed',
  ];
  const STOP_INTENTS: readonly StopIntent[] = ['stop-now', 'end-run', 'quit'];
  const SETTLED_PHASES: readonly StopPhase[] = ['parked', 'ended', 'failed'];
  const CASES: [string, StopIntent, StopPhase][] = INTENTS.flatMap((intent) =>
    PHASES.map((phase): [string, StopIntent, StopPhase] => [`${intent} ${phase}`, intent, phase]),
  );

  it.each(CASES)(
    'counts a stop as in progress until it parks, ends or fails: %s',
    (_case, intent, phase) => {
      const stopping = STOP_INTENTS.includes(intent) && !SETTLED_PHASES.includes(phase);

      expect(stopModule.stopInProgress).toBeTypeOf('function');
      expect(
        stopModule.stopInProgress({
          intent,
          phase,
          requestedAt: null,
          parked: null,
          seatChange: false,
        }),
      ).toBe(stopping);
    },
  );
});

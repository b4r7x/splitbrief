import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { SeatAttempt } from '../../runners/transient.js';
import { transitionAndSave } from '../state-ops.js';
import {
  resumeSeatWait,
  runSeatCall,
  seatResetWaitDeadline,
  waitForSeatReset,
} from './seat-wait.js';

let dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('seat-wait-test');
  dirs.push(projectDir);
  const sessionId = 'sess-seat-wait';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('seatResetWaitDeadline', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('takes a reset at most ten minutes away and refuses a longer one', () => {
    expect(
      seatResetWaitDeadline({ message: 'HTTP 429 (retry-after: 300)' }, now)?.toISOString(),
    ).toBe('2026-01-01T00:05:00.000Z');
    expect(
      seatResetWaitDeadline({ message: 'HTTP 429 (retry-after: 600)' }, now)?.toISOString(),
    ).toBe('2026-01-01T00:10:00.000Z');
    expect(seatResetWaitDeadline({ message: 'HTTP 429 (retry-after: 601)' }, now)).toBeUndefined();
    expect(
      seatResetWaitDeadline({ message: 'usage limit reached · resets in 2h6m30s' }, now),
    ).toBeUndefined();
    expect(seatResetWaitDeadline({ message: 'connection refused' }, now)).toBeUndefined();
  });

  it('waits only on a usage-limit failure, whatever else mentions a reset', () => {
    expect(
      seatResetWaitDeadline({ message: 'Tests failed: please try again in 3 minutes' }, now),
    ).toBeUndefined();
    expect(
      seatResetWaitDeadline(
        { message: 'HTTP 429 (retry-after: 300)', outcome: 'checkout-changed' },
        now,
      ),
    ).toBeUndefined();
    expect(
      seatResetWaitDeadline(
        { message: 'HTTP 429 (retry-after: 300)', outcome: 'usage-limit' },
        now,
      )?.toISOString(),
    ).toBe('2026-01-01T00:05:00.000Z');
  });
});

describe('runSeatCall', () => {
  it('waits out a five-minute reset and repeats the same call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    let calls = 0;
    const discarded: string[] = [];
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: { message: 'HTTP 429 (retry-after: 300)' }, value: 'limited' }
        : { ok: true, value: 'done' };
    };

    const pending = runSeatCall({ ref, state, seat: 'build' }, call, (value) =>
      discarded.push(value),
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(loadState(ref)?.seatWait).toEqual({
      seat: 'build',
      resetAt: '2026-01-01T00:05:00.000Z',
    });
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300_000);
    await expect(pending).resolves.toEqual({ ok: true, value: 'done' });
    expect(calls).toBe(2);
    // The attempt the wait replaces keeps its usage with the caller.
    expect(discarded).toEqual(['limited']);
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  it('leaves a two-hour reset to the runner-usage-limit halt without waiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    let calls = 0;
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return {
        ok: false,
        failure: { message: 'usage limit reached · resets in 2h6m30s' },
        value: 'limited',
      };
    };

    const result = await runSeatCall({ ref, state, seat: 'build' }, call, () => {});

    expect(result).toEqual({
      ok: false,
      failure: { message: 'usage limit reached · resets in 2h6m30s' },
      value: 'limited',
    });
    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  it('does not wait on a non-limit failure that says to try again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    const call = async (): Promise<SeatAttempt<string>> => ({
      ok: false,
      failure: { message: 'Tests failed: please try again in 3 minutes' },
      value: 'failed',
    });

    const result = await runSeatCall({ ref, state, seat: 'build' }, call, () => {});

    expect(result.ok).toBe(false);
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  it('retries a transient failure, publishes seat_retry, and counts no attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    let calls = 0;
    const discarded: string[] = [];
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? {
            ok: false,
            failure: { message: 'connect ECONNREFUSED 127.0.0.1:443' },
            value: 'refused',
          }
        : { ok: true, value: 'done' };
    };

    const pending = runSeatCall({ ref, state, seat: 'build' }, call, (value) =>
      discarded.push(value),
    );
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: true, value: 'done' });

    expect(calls).toBe(2);
    expect(discarded).toEqual(['refused']);
    const retries = events.filter((event) => event.type === 'seat_retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ seat: 'build', attempt: 1, delayMs: 2_000 });
    // A transient retry writes no state, so no attempt is counted against the lineage.
    expect(loadState(ref)).toBeNull();
  });
});

describe('waitForSeatReset', () => {
  it('leaves the persisted wait in place when the signal aborts it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    const controller = new AbortController();

    const pending = waitForSeatReset({
      ref,
      state,
      seat: 'build',
      deadline: new Date('2026-01-01T00:05:00.000Z'),
      signal: controller.signal,
    });
    await controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    // The wait survives the stop: a resume reads it back and keeps waiting.
    expect(loadState(ref)?.seatWait?.resetAt).toBe('2026-01-01T00:05:00.000Z');
  });
});

describe('resumeSeatWait', () => {
  it('waits for a persisted deadline still in the future, then releases the seat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const seeded = transitionAndSave(ref, makeImplState([makeTask()]), {
      type: 'SET_SEAT_WAIT',
      seat: 'plan',
      resetAt: '2026-01-01T00:04:00.000Z',
    });

    const pending = resumeSeatWait({ ref, state: seeded });
    await vi.advanceTimersByTimeAsync(1);

    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);
    expect(loadState(ref)?.seatWait?.seat).toBe('plan');

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    const resumed = await pending;
    expect(resumed.seatWait).toBeUndefined();
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  it('releases a persisted deadline already in the past without waiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const seeded = transitionAndSave(ref, makeImplState([makeTask()]), {
      type: 'SET_SEAT_WAIT',
      seat: 'build',
      resetAt: '2026-01-01T00:05:00.000Z',
    });

    const resumed = await resumeSeatWait({ ref, state: seeded });

    expect(resumed.seatWait).toBeUndefined();
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });
});

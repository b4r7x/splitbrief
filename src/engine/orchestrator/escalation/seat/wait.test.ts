import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { setupSeatWaitProject } from '#testing/helpers/seat-wait-project.js';
import { loadState } from '../../../../core/state/persistence.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { resumeSeatWait, seatResetWaitDeadline, waitForSeatReset } from './wait.js';

const setupProject = setupSeatWaitProject();

afterEach(() => {
  vi.useRealTimers();
});

describe('seatResetWaitDeadline', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('takes a reported reset of any length', () => {
    expect(
      seatResetWaitDeadline({ message: 'HTTP 429 (retry-after: 300)' }, now)?.toISOString(),
    ).toBe('2026-01-01T00:05:00.000Z');
    expect(
      seatResetWaitDeadline({ message: 'HTTP 429 (retry-after: 601)' }, now)?.toISOString(),
    ).toBe('2026-01-01T00:10:01.000Z');
    expect(
      seatResetWaitDeadline(
        { message: 'usage limit reached · resets in 2h6m30s' },
        now,
      )?.toISOString(),
    ).toBe('2026-01-01T02:06:30.000Z');
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

describe('waitForSeatReset', () => {
  it('ends the live wait but keeps the persisted one when the signal aborts it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    const controller = new AbortController();

    const pending = waitForSeatReset({
      ref,
      state,
      wait: { seat: 'build', resetAt: '2026-01-01T00:05:00.000Z' },
      signal: controller.signal,
    });
    await controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    // The wait survives the stop: a resume reads it back and keeps waiting.
    expect(loadState(ref)?.seatWait?.resetAt).toBe('2026-01-01T00:05:00.000Z');
    // A steer re-runs the call at once, so the live wait line must not outlive the abort; the
    // end says the saved wait stays.
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toEqual([
      expect.objectContaining({ seat: 'build', kept: true }),
    ]);
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
      wait: { seat: 'plan', resetAt: '2026-01-01T00:04:00.000Z' },
    });

    const pending = resumeSeatWait({ ref, state: seeded, config: makeConfig() });
    await vi.advanceTimersByTimeAsync(1);

    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toHaveLength(0);
    expect(loadState(ref)?.seatWait?.seat).toBe('plan');

    await vi.advanceTimersByTimeAsync(4 * 60_000 - 2);
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2);
    const resumed = await pending;
    expect(resumed.seatWait).toBeUndefined();
    expect(loadState(ref)?.seatWait).toBeUndefined();
    const ends = events.filter((event) => event.type === 'seat_wait_ended');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ seat: 'plan' });
  });

  it('releases a persisted deadline already in the past without waiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const seeded = transitionAndSave(ref, makeImplState([makeTask()]), {
      type: 'SET_SEAT_WAIT',
      wait: { seat: 'build', resetAt: '2026-01-01T00:05:00.000Z' },
    });

    const resumed = await resumeSeatWait({ ref, state: seeded, config: makeConfig() });

    expect(resumed.seatWait).toBeUndefined();
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    const ends = events.filter((event) => event.type === 'seat_wait_ended');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ seat: 'build' });
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  it('releases a wait whose recorded tool no longer runs the seat, without waiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const seeded = transitionAndSave(ref, makeImplState([makeTask()]), {
      type: 'SET_SEAT_WAIT',
      wait: {
        seat: 'build',
        resetAt: '2026-01-01T00:04:00.000Z',
        holds: { tool: 'codex', kind: 'cli' },
      },
    });

    const resumed = await resumeSeatWait({
      ref,
      state: seeded,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }),
    });

    expect(resumed.seatWait).toBeUndefined();
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    const ends = events.filter((event) => event.type === 'seat_wait_ended');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ seat: 'build' });
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  // Retry at after a save: the wait counts down Codex's limit and holds the saved OpenCode seat.
  const OPENCODE_HELD = { tool: 'opencode', kind: 'cli' } as const;
  const LIMITED_PROFILES = {
    implementerProfiles: {
      default: 'small',
      profiles: {
        big: { kind: 'cli', tool: 'codex' },
        small: { kind: 'cli', tool: 'claude-code' },
      },
    },
  } as const;
  it.each([
    {
      name: 'the limited runner',
      wait: { tool: 'codex', kind: 'cli', holds: OPENCODE_HELD },
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
      waits: true,
    },
    {
      name: 'the limited runner, recorded without its kind',
      wait: { tool: 'codex', holds: OPENCODE_HELD },
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
      waits: true,
    },
    {
      name: 'the limited runner on the held BUILD profile',
      wait: { tool: 'codex', kind: 'cli', holds: { ...OPENCODE_HELD, profile: 'big' } },
      config: makeConfig(LIMITED_PROFILES),
      waits: true,
    },
    {
      name: 'the held seat',
      wait: { tool: 'codex', kind: 'cli', holds: OPENCODE_HELD },
      config: makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } }),
      waits: true,
    },
    {
      name: 'a third tool',
      wait: { tool: 'codex', kind: 'cli', holds: OPENCODE_HELD },
      config: makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }),
      waits: false,
    },
    {
      name: 'the limited tool id on another kind',
      wait: { tool: 'codex', kind: 'api', holds: OPENCODE_HELD },
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
      waits: false,
    },
    {
      name: 'the limited runner on another BUILD profile only',
      wait: { tool: 'claude-code', kind: 'cli', holds: { ...OPENCODE_HELD, profile: 'big' } },
      config: makeConfig(LIMITED_PROFILES),
      waits: false,
    },
  ] as const)(
    'a wait held on another seat, continued on $name',
    async ({ wait, config, waits }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const { projectDir, sessionId } = setupProject();
      const { bus, events } = makeBusRecorder();
      const ref = { projectDir, sessionId, bus };
      const seeded = transitionAndSave(ref, makeImplState([makeTask()]), {
        type: 'SET_SEAT_WAIT',
        wait: { seat: 'build', resetAt: '2026-01-01T00:04:00.000Z', ...wait },
      });

      const pending = resumeSeatWait({ ref, state: seeded, config });
      await vi.advanceTimersByTimeAsync(1);

      expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(
        waits ? 1 : 0,
      );
      expect(loadState(ref)?.seatWait !== undefined).toBe(waits);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await pending;
      expect(events.filter((event) => event.type === 'seat_wait_ended')).toHaveLength(1);
    },
  );
});

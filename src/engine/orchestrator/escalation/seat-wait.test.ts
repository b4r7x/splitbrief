import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { writeConfig } from '../../../core/config/load/io.js';
import type { Config } from '../../../core/schemas/config.js';
import type { CliToolDetection } from '../../../core/discovery/detection.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { CREW_SEAT_IDS, seatIdsOf } from '../../../core/crew/identity.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { seatWaitToolWord } from '../../../core/sessions/seat-wait-line.js';
import { isTransientSeatFailure, type SeatAttempt } from '../../runners/transient.js';
import { throwMappedError } from '../../streaming/stream-errors.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { configWithSwitchedSeat } from '../recovery/switch-seat.js';
import { transitionAndSave } from '../state-ops.js';
import {
  resumeSeatWait,
  runSeatCall,
  seatFailureFromError,
  seatResetWaitDeadline,
  waitForSeatReset,
} from './seat-wait.js';

const CODEX: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };
const CODEX_WITH_FALLBACK: RunnerConfig = { ...CODEX, fallback: { tool: 'claude-code' } };
// The Plus/Pro form of the Codex limit (usage-limit.ts), with a forty-minute reset.
const FORTY_MINUTE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro or try again in 40 minutes.";

const live = vi.hoisted(() => ({ detectAvailableCliTools: vi.fn() }));
vi.mock('../../detection/detect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../detection/detect.js')>()),
  ...live,
}));

let dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  live.detectAvailableCliTools.mockReset();
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

/** The seat as `config.yaml` has it and the tools the last readiness pass remembered. */
async function saveSeatOfRecord(
  projectDir: string,
  config: Config,
  remembered: CliToolDetection[],
): Promise<void> {
  writeConfig(projectDir, config);
  await rememberDetectedTools(projectDir, remembered);
}

/** Settles when the bus publishes the first event of this type; the seat call reads files before it waits. */
function published(bus: EventBus, type: EngineEvent['type']): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = bus.subscribe((event) => {
      if (event.type !== type) return;
      unsubscribe();
      resolve();
    });
  });
}

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

describe('seatFailureFromError', () => {
  it('keeps a provider 5xx an API seat threw retryable', () => {
    let thrown: unknown;
    try {
      throwMappedError(Object.assign(new Error('503 status code (no body)'), { status: 503 }), {
        provider: 'openai',
      });
    } catch (err) {
      thrown = err;
    }
    expect(isTransientSeatFailure(seatFailureFromError(thrown))).toBe(true);
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

    const pending = runSeatCall(
      {
        ref,
        state,
        seat: 'build',
        runner: CODEX,
        config: makeConfig({ implementer: CODEX }),
        profile: 'default',
      },
      call,
      (value) => discarded.push(value),
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(loadState(ref)?.seatWait).toEqual({
      seat: 'build',
      resetAt: '2026-01-01T00:05:00.000Z',
      tool: 'codex',
      kind: 'cli',
      holds: { tool: 'codex', kind: 'cli', profile: 'default' },
    });
    const starts = events.filter((event) => event.type === 'seat_wait_started');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      seat: 'build',
      tool: 'OpenAI Codex CLI',
      wait: loadState(ref)?.seatWait,
    });
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300_000);
    await expect(pending).resolves.toEqual({ ok: true, value: 'done' });
    expect(calls).toBe(2);
    // The attempt the wait replaces keeps its usage with the caller.
    expect(discarded).toEqual(['limited']);
    expect(loadState(ref)?.seatWait).toBeUndefined();
    const ends = events.filter((event) => event.type === 'seat_wait_ended');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ seat: 'build' });
    expect(ends[0]).not.toHaveProperty('kept');
  });

  it('returns a limit with a two-minute reset at once when the seat has a fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const config = makeConfig({ implementer: CODEX_WITH_FALLBACK });
    await saveSeatOfRecord(projectDir, config, [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'claude-code'),
    ]);
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    const discarded: string[] = [];
    let calls = 0;
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: { message: 'HTTP 429 (retry-after: 120)' }, value: 'limited' }
        : { ok: true, value: 'done' };
    };

    const started = published(bus, 'seat_wait_started');
    const pending = runSeatCall(
      { ref, state, seat: 'build', runner: config.implementer, config },
      call,
      (value) => discarded.push(value),
    );
    await Promise.race([started, pending]);

    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    await expect(pending).resolves.toEqual({
      ok: false,
      failure: { message: 'HTTP 429 (retry-after: 120)' },
      value: 'limited',
    });
    expect(calls).toBe(1);
    // The limited attempt goes back to the caller, which books its usage with the halt.
    expect(discarded).toEqual([]);
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  it('waits a two-minute reset when the declared fallback is not installed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const config = makeConfig({ implementer: CODEX_WITH_FALLBACK });
    await saveSeatOfRecord(projectDir, config, [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unavailable', 'claude-code'),
    ]);
    live.detectAvailableCliTools.mockResolvedValue([cliDetectionFor('unavailable', 'claude-code')]);
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    let calls = 0;
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: { message: 'HTTP 429 (retry-after: 120)' }, value: 'limited' }
        : { ok: true, value: 'done' };
    };

    const started = published(bus, 'seat_wait_started');
    const pending = runSeatCall(
      { ref, state, seat: 'build', runner: config.implementer, config },
      call,
      () => {},
    );
    await Promise.race([started, pending]);

    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);
    expect(loadState(ref)?.seatWait?.resetAt).toBe('2026-01-01T00:02:00.000Z');
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(pending).resolves.toEqual({ ok: true, value: 'done' });
    expect(calls).toBe(2);
  });

  it('stops on Esc during the live fallback check and keeps the limited attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const config = makeConfig({ implementer: CODEX_WITH_FALLBACK });
    // The remembered pass has no row for the fallback tool, so the seat call checks it live.
    await saveSeatOfRecord(projectDir, config, [cliDetectionFor('ready', 'codex')]);
    let checking: () => void = () => {};
    const checked = new Promise<void>((resolve) => {
      checking = resolve;
    });
    // A sign-in check that hangs to the probe ceiling unless its signal stops it.
    live.detectAvailableCliTools.mockImplementation(
      (options: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve([cliDetectionFor('ready', 'claude-code')]),
            60_000,
          );
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(options.signal?.reason);
          });
          checking();
        }),
    );
    const { bus, events } = makeBusRecorder();
    const controller = new AbortController();
    const discarded: string[] = [];
    const call = async (): Promise<SeatAttempt<string>> => ({
      ok: false,
      failure: { message: 'HTTP 429 (retry-after: 120)' },
      value: 'limited',
    });

    let outcome = 'pending';
    void runSeatCall(
      {
        ref: { projectDir, sessionId, bus },
        state: makeImplState([makeTask()]),
        seat: 'build',
        runner: config.implementer,
        config,
        signal: controller.signal,
      },
      call,
      (value) => discarded.push(value),
    ).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : 'rejected';
      },
    );
    await checked;
    controller.abort(new Error('stopped'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(outcome).toBe('stopped');
    expect(discarded).toEqual(['limited']);
    expect(events.filter((event) => event.type === 'seat_wait_started')).toEqual([]);
    expect(loadState({ projectDir, sessionId })?.seatWait).toBeUndefined();
  });

  it('waits a two-minute reset when the seat was switched by hand to its fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const switched = configWithSwitchedSeat(
      makeConfig({ implementer: CODEX_WITH_FALLBACK }),
      'build',
      { tool: 'claude-code' },
    );
    if (switched === null) throw new Error('the switch to the fallback was refused');
    expect(switched.implementer).toMatchObject({
      tool: 'claude-code',
      fallback: { tool: 'claude-code' },
    });
    await saveSeatOfRecord(projectDir, switched, [
      cliDetectionFor('ready', 'claude-code'),
      cliDetectionFor('ready', 'codex'),
    ]);
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    let calls = 0;
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: { message: 'HTTP 429 (retry-after: 120)' }, value: 'limited' }
        : { ok: true, value: 'done' };
    };

    const started = published(bus, 'seat_wait_started');
    const pending = runSeatCall(
      { ref, state, seat: 'build', runner: switched.implementer, config: switched },
      call,
      () => {},
    );
    await Promise.race([started, pending]);

    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(pending).resolves.toEqual({ ok: true, value: 'done' });
    expect(calls).toBe(2);
  });

  it('returns a forty-minute limit at once when a fallback was saved during the run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const config = makeConfig({ implementer: CODEX });
    await saveSeatOfRecord(projectDir, makeConfig({ implementer: CODEX_WITH_FALLBACK }), [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'claude-code'),
    ]);
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    let calls = 0;
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: { message: FORTY_MINUTE_LIMIT }, value: 'limited' }
        : { ok: true, value: 'done' };
    };

    const started = published(bus, 'seat_wait_started');
    const pending = runSeatCall(
      { ref, state, seat: 'build', runner: config.implementer, config },
      call,
      () => {},
    );
    await Promise.race([started, pending]);

    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    await expect(pending).resolves.toEqual({
      ok: false,
      failure: { message: FORTY_MINUTE_LIMIT },
      value: 'limited',
    });
    expect(calls).toBe(1);
  });

  it('waits a forty-minute reset when the seat has no fallback, then repeats the call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    let calls = 0;
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: { message: FORTY_MINUTE_LIMIT }, value: 'limited' }
        : { ok: true, value: 'done' };
    };

    const pending = runSeatCall(
      { ref, state, seat: 'build', runner: CODEX, config: makeConfig({ implementer: CODEX }) },
      call,
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);
    expect(loadState(ref)?.seatWait?.resetAt).toBe('2026-01-01T00:40:00.000Z');
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: true, value: 'done' });
    expect(calls).toBe(2);
    expect(loadState(ref)?.seatWait).toBeUndefined();
  });

  it('waits the reset when the seat already used its automatic switch in this run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const config = makeConfig({ implementer: CODEX_WITH_FALLBACK });
    await saveSeatOfRecord(projectDir, config, [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'claude-code'),
    ]);
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()], {
      seatSwitches: [
        {
          seat: 'build',
          from: 'Claude Code CLI',
          to: 'OpenAI Codex CLI',
          cause: 'runner-usage-limit',
          auto: true,
          configRevision: 'revision',
          ts: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    let calls = 0;
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: { message: 'HTTP 429 (retry-after: 120)' }, value: 'limited' }
        : { ok: true, value: 'done' };
    };

    const started = published(bus, 'seat_wait_started');
    const pending = runSeatCall(
      { ref, state, seat: 'build', runner: config.implementer, config },
      call,
      () => {},
    );
    await Promise.race([started, pending]);

    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(pending).resolves.toEqual({ ok: true, value: 'done' });
    expect(calls).toBe(2);
  });

  it('stops a forty-minute wait on Esc and keeps the saved wait for a resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = makeImplState([makeTask()]);
    const controller = new AbortController();
    let calls = 0;
    const call = async (): Promise<SeatAttempt<string>> => {
      calls += 1;
      return { ok: false, failure: { message: FORTY_MINUTE_LIMIT }, value: 'limited' };
    };

    const pending = runSeatCall(
      {
        ref,
        state,
        seat: 'build',
        runner: CODEX,
        config: makeConfig({ implementer: CODEX }),
        signal: controller.signal,
      },
      call,
      () => {},
    );
    const settled = pending.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    controller.abort(new Error('stopped'));
    await vi.runAllTimersAsync();

    expect(await settled).toBe('stopped');
    expect(calls).toBe(1);
    expect(loadState(ref)?.seatWait?.resetAt).toBe('2026-01-01T00:40:00.000Z');
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toEqual([
      expect.objectContaining({ seat: 'build', kept: true }),
    ]);
  });

  it('keeps a saved wait of another seat while its own call runs', async () => {
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const state = transitionAndSave(ref, makeImplState([makeTask()]), {
      type: 'SET_SEAT_WAIT',
      wait: { seat: 'plan', resetAt: '2026-01-01T03:00:00.000Z' },
    });

    const result = await runSeatCall(
      { ref, state, seat: 'build', runner: CODEX, config: makeConfig({ implementer: CODEX }) },
      async (): Promise<SeatAttempt<string>> => ({ ok: true, value: 'done' }),
      () => {},
    );

    expect(result).toEqual({ ok: true, value: 'done' });
    expect(loadState(ref)?.seatWait?.seat).toBe('plan');
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toEqual([]);
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

    const result = await runSeatCall(
      { ref, state, seat: 'build', runner: CODEX, config: makeConfig({ implementer: CODEX }) },
      call,
      () => {},
    );

    expect(result.ok).toBe(false);
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toHaveLength(0);
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

    const pending = runSeatCall(
      { ref, state, seat: 'build', runner: CODEX, config: makeConfig({ implementer: CODEX }) },
      call,
      (value) => discarded.push(value),
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

const HALTED: readonly { name: string; runner: RunnerConfig; word: string }[] = [
  {
    name: 'cli codex',
    runner: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
    word: 'OpenAI Codex CLI',
  },
  {
    name: 'cli claude-code',
    runner: { kind: 'cli', tool: 'claude-code', model: 'claude-3-5-sonnet' },
    word: 'Claude Code CLI',
  },
  {
    name: 'cli opencode route',
    runner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-chat' },
    word: 'OpenCode CLI',
  },
  {
    name: 'api ollama',
    runner: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'llama3',
    } as RunnerConfig,
    word: 'Ollama',
  },
  {
    name: 'shell',
    runner: { kind: 'shell', command: './impl.sh' } as RunnerConfig,
    word: 'Custom Shell',
  },
  {
    name: 'agent',
    runner: { kind: 'agent', command: './agent.sh' } as RunnerConfig,
    word: 'Agent',
  },
];

/** The tool the open-run byline names for a run that waits on a seat. */
function waitWord(state: WorkflowState | null): string | undefined {
  return state?.seatWait === undefined ? undefined : seatWaitToolWord(state, state.seatWait);
}

describe('the seat wait names the runner it waits on', () => {
  // The run started on Claude Code for every seat; the halted call ran on another runner.
  const STARTED = { plannerTool: 'claude-code', implementerTool: 'claude-code' };

  it.each(CREW_SEAT_IDS.flatMap((seat) => HALTED.map((halted) => ({ seat, ...halted }))))(
    'a $seat call on $name',
    async ({ seat, runner, word }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const { projectDir, sessionId } = setupProject();
      const { bus } = makeBusRecorder();
      const ref = { projectDir, sessionId, bus };
      let calls = 0;
      const call = async (): Promise<SeatAttempt<string>> => {
        calls += 1;
        return calls === 1
          ? { ok: false, failure: { message: 'HTTP 429 (retry-after: 300)' }, value: 'limited' }
          : { ok: true, value: 'done' };
      };

      const pending = runSeatCall(
        { ref, state: makeImplState([makeTask()], STARTED), seat, runner, config: makeConfig() },
        call,
        () => {},
      );
      await vi.advanceTimersByTimeAsync(1);

      const waiting = loadState(ref);
      expect(waiting?.seatWait).toEqual({
        seat,
        resetAt: '2026-01-01T00:05:00.000Z',
        tool: seatIdsOf(runner).tool,
        kind: runner.kind,
        holds: { tool: seatIdsOf(runner).tool, kind: runner.kind },
      });
      expect(waitWord(waiting)).toBe(word);
      await vi.advanceTimersByTimeAsync(300_000);
      await expect(pending).resolves.toEqual({ ok: true, value: 'done' });
    },
  );

  it('names the tool of a wait saved without one as the stopped run reads it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus, events } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const seeded = transitionAndSave(ref, makeImplState([makeTask()], STARTED), {
      type: 'SET_SEAT_WAIT',
      wait: { seat: 'build', resetAt: '2026-01-01T00:04:00.000Z' },
    });

    const pending = resumeSeatWait({ ref, state: seeded, config: makeConfig() });
    await vi.advanceTimersByTimeAsync(1);

    const started = events.find((event) => event.type === 'seat_wait_started');
    expect(waitWord(loadState(ref))).toBe('Claude Code CLI');
    expect(started).toMatchObject({ tool: 'Claude Code CLI' });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await pending;
  });

  it('keeps the recorded runner while a resumed run waits again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { projectDir, sessionId } = setupProject();
    const { bus } = makeBusRecorder();
    const ref = { projectDir, sessionId, bus };
    const wait = {
      seat: 'build',
      resetAt: '2026-01-01T00:04:00.000Z',
      tool: 'ollama',
      kind: 'api',
    } as const;
    const seeded = transitionAndSave(ref, makeImplState([makeTask()], STARTED), {
      type: 'SET_SEAT_WAIT',
      wait,
    });

    const pending = resumeSeatWait({ ref, state: seeded, config: makeConfig() });
    await vi.advanceTimersByTimeAsync(1);

    expect(loadState(ref)?.seatWait).toEqual(wait);
    expect(waitWord(loadState(ref))).toBe('Ollama');
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await pending;
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { CREW_SEAT_IDS, seatIdsOf } from '../../../core/crew/identity.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import type { SeatAttempt } from '../../runners/transient.js';
import { transitionAndSave } from '../state-ops.js';
import {
  resumeSeatWait,
  runSeatCall,
  seatResetWaitDeadline,
  waitForSeatReset,
} from './seat-wait.js';

const CODEX: RunnerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' };

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

    const pending = runSeatCall(
      { ref, state, seat: 'build', runner: CODEX, profile: 'default' },
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
    expect(starts[0]).toMatchObject({ seat: 'build', tool: 'OpenAI Codex CLI' });
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

    const result = await runSeatCall({ ref, state, seat: 'build', runner: CODEX }, call, () => {});

    expect(result).toEqual({
      ok: false,
      failure: { message: 'usage limit reached · resets in 2h6m30s' },
      value: 'limited',
    });
    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toHaveLength(0);
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

    const result = await runSeatCall({ ref, state, seat: 'build', runner: CODEX }, call, () => {});

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

    const pending = runSeatCall({ ref, state, seat: 'build', runner: CODEX }, call, (value) =>
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
    // A steer re-runs the call at once, so the live wait line must not outlive the abort.
    expect(events.filter((event) => event.type === 'seat_wait_ended')).toEqual([
      expect.objectContaining({ seat: 'build' }),
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

    await vi.advanceTimersByTimeAsync(4 * 60_000);
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
  if (state === null) return undefined;
  const status = deriveRunStatus({ state, liveness: 'not-alive' });
  return status.kind === 'open' &&
    status.stop.kind === 'stopped' &&
    status.stop.on.kind === 'seat-wait'
    ? status.stop.on.tool
    : undefined;
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
        { ref, state: makeImplState([makeTask()], STARTED), seat, runner },
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

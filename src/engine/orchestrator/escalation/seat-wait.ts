import {
  getRunnerDisplayName,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { SeatWait } from '../../../core/schemas/workflow/seat.js';
import { heldSeatOf, seatWaitMoved } from '../../../core/sessions/held-seat.js';
import {
  seatRetrySentence,
  seatWaitSentence,
  seatWaitToolWord,
} from '../../../core/sessions/seat-wait-line.js';
import { loadState } from '../../../core/state/persistence.js';
import { thrownSeatFailure } from '../../implementers/pipeline/call-result.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import { classifySeatFailure } from '../../runners/seat-failure.js';
import {
  abortableDelay,
  withSeatRetry,
  type SeatAttempt,
  type SeatFailure,
  type SeatRetryInfo,
} from '../../runners/transient.js';
import { parseUsageLimitReset } from '../../runners/usage-limit.js';
import { publishSeatRetry, publishSeatWaitEnded, publishSeatWaitStarted } from '../events.js';
import { automaticSeatSwitch } from '../recovery/builders/task.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';
import { transitionAndSave } from '../state-ops.js';
import type { WorkflowPersistenceContext } from '../types.js';

export type SeatCallContext = Readonly<{
  ref: WorkflowPersistenceContext;
  /** The state the call starts on; the wait re-reads the persisted head before it writes. */
  state: WorkflowState;
  seat: CrewSeatId;
  /** The runner the call runs on, which a wait for its reset names. */
  runner: RunnerConfig;
  /** The run config, which the seat of record falls back to when the project has no config file. */
  config: Config;
  /** The BUILD profile the runner is, which a wait for its reset holds. */
  profile?: string | undefined;
  signal?: AbortSignal | undefined;
  onStateChange?: ((state: WorkflowState) => void) | undefined;
}>;

/** The implementer result fields the seat-trouble mapper reads. */
export type ImplementerSeatResult = Readonly<{
  success: boolean;
  error?: string | undefined;
  outcome?: RunnerFailureOutcomeState | undefined;
  blocked?: { question: string; filesNeeded: string[] } | undefined;
}>;

/**
 * One implementer attempt as the seat-trouble wrapper sees it: a success or a
 * blocked report is the attempt's verdict, anything else is a failure that
 * carries the runner's own words and its machine outcome so the classifier can
 * tell a transient fault from an outcome it already knows.
 */
export function implementerSeatAttempt<T extends ImplementerSeatResult>(
  result: T,
  fallbackMessage: string,
): SeatAttempt<T> {
  if (result.success || result.blocked !== undefined) return { ok: true, value: result };
  return {
    ok: false,
    failure: {
      message: result.error ?? fallbackMessage,
      outcome: result.outcome,
    },
    value: result,
  };
}

/**
 * The reset a limit failure named, however far away. Only a usage-limit failure
 * can earn a wait; an outcome that names something else, an unreported outcome
 * whose words do not read as a limit, or a reset already past returns undefined
 * and the caller keeps the runner-usage-limit halt with the seat picker.
 */
export function seatResetWaitDeadline(
  failure: SeatFailure,
  now: Date = new Date(),
): Date | undefined {
  const classification = classifySeatFailure({
    message: failure.message,
    ...(failure.outcome !== undefined && { outcome: failure.outcome }),
    source: 'thrown',
  });
  if (classification.class !== 'rate-limited') return undefined;
  const resetAt = parseUsageLimitReset(failure.message, now);
  if (resetAt === null) return undefined;
  const waitMs = resetAt.getTime() - now.getTime();
  if (waitMs <= 0) return undefined;
  return resetAt;
}

/** The runner's own words out of a thrown call error, for the classifier. */
export function seatFailureFromError(err: unknown): SeatFailure {
  return { message: thrownSeatFailure(err).words };
}

/**
 * Park the seat on the persisted wait, publish it, wait until the deadline,
 * then release it. An abort ends the live wait with `kept` and leaves
 * `state.seatWait` in place, so a resume reads the deadline back and keeps
 * waiting before the task continues.
 */
export async function waitForSeatReset(
  input: Readonly<{
    ref: WorkflowPersistenceContext;
    state: WorkflowState;
    wait: SeatWait;
    signal?: AbortSignal | undefined;
  }>,
): Promise<WorkflowState> {
  const base = loadState(input.ref) ?? input.state;
  let state = transitionAndSave(input.ref, base, { type: 'SET_SEAT_WAIT', wait: input.wait });
  publishSeatWaitStarted(
    { bus: input.ref.bus, phase: state.phase },
    input.wait,
    seatWaitToolWord(state, input.wait),
  );
  try {
    await abortableDelay(new Date(input.wait.resetAt).getTime() - Date.now(), input.signal);
  } catch (error) {
    publishSeatWaitEnded({ bus: input.ref.bus, phase: state.phase }, input.wait.seat, true);
    throw error;
  }
  publishSeatWaitEnded({ bus: input.ref.bus, phase: state.phase }, input.wait.seat);
  state = transitionAndSave(input.ref, state, { type: 'CLEAR_SEAT_WAIT' });
  return state;
}

/**
 * A persisted wait is honored on re-entry: a deadline still in the future is
 * waited for before the task continues, one already past is just released, and
 * so is one whose seat this entry's config runs on a tool that is neither the
 * seat the wait holds nor the runner whose limit it waits out.
 */
export async function resumeSeatWait(
  input: Readonly<{
    ref: WorkflowPersistenceContext;
    state: WorkflowState;
    config: Config;
    signal?: AbortSignal | undefined;
  }>,
): Promise<WorkflowState> {
  const wait = input.state.seatWait;
  if (wait === undefined) return input.state;
  const deadline = new Date(wait.resetAt);
  const moved = seatWaitMoved(wait, input.config);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now() || moved) {
    publishSeatWaitEnded({ bus: input.ref.bus, phase: input.state.phase }, wait.seat);
    return transitionAndSave(input.ref, input.state, { type: 'CLEAR_SEAT_WAIT' });
  }
  return waitForSeatReset({
    ref: input.ref,
    state: input.state,
    wait,
    ...(input.signal !== undefined && { signal: input.signal }),
  });
}

type SeatLadderPort = Readonly<{
  signal?: AbortSignal | undefined;
  onRetry: (info: SeatRetryInfo) => void;
  /** Whether the call waits for the reset its limit named; false gives the limit back to the caller. */
  waits: () => Promise<boolean>;
  wait: (deadline: Date) => Promise<void>;
}>;

async function seatCallLadder<T>(
  call: (signal: AbortSignal) => Promise<SeatAttempt<T>>,
  onDiscarded: (value: T) => void,
  port: SeatLadderPort,
): Promise<SeatAttempt<T>> {
  const attempt = (): Promise<SeatAttempt<T>> =>
    withSeatRetry(call, {
      ...(port.signal !== undefined && { signal: port.signal }),
      onRetry: port.onRetry,
      onDiscarded,
    });
  const first = await attempt();
  if (first.ok) return first;
  const deadline = seatResetWaitDeadline(first.failure);
  if (deadline === undefined) return first;
  const waits = await port.waits().catch((error: unknown) => {
    onDiscarded(first.value);
    throw error;
  });
  if (!waits) return first;
  onDiscarded(first.value);
  await port.wait(deadline);
  return attempt();
}

/**
 * One seat call with the whole seat-trouble ladder around it: a transient
 * failure retries with backoff. A limit comes back at once as the failure the
 * caller halts on when the halt would move the seat to its fallback by itself
 * (`automaticSeatSwitch`). Otherwise a reported reset of any length is waited
 * out once and the same call repeats, and an unknown reset comes back as the
 * failure. None of these retries is a lineage attempt — no state transition
 * counts them. `onDiscarded` receives every attempt value a retry or the wait
 * replaced, or a stop ended, so the caller can keep its usage.
 *
 * A wait of this seat still saved when the call starts is one a `/steer` cut:
 * a stop or a Retry at is waited out on re-entry before any seat call runs.
 * The steered call runs now and the wait is dropped; a limit that still holds
 * starts a new wait.
 */
export async function runSeatCall<T>(
  ctx: SeatCallContext,
  call: (signal: AbortSignal) => Promise<SeatAttempt<T>>,
  onDiscarded: (value: T) => void,
): Promise<SeatAttempt<T>> {
  let state = ctx.state;
  const head = loadState(ctx.ref) ?? state;
  if (head.seatWait?.seat === ctx.seat) {
    publishSeatWaitEnded({ bus: ctx.ref.bus, phase: head.phase }, ctx.seat);
    state = transitionAndSave(ctx.ref, head, { type: 'CLEAR_SEAT_WAIT' });
    ctx.onStateChange?.(state);
  }

  return seatCallLadder(call, onDiscarded, {
    ...(ctx.signal !== undefined && { signal: ctx.signal }),
    onRetry: (info) =>
      publishSeatRetry({ bus: ctx.ref.bus, phase: ctx.state.phase }, { seat: ctx.seat, ...info }),
    waits: async () => {
      const seatSwap = await loadSeatSwapContext({
        projectDir: ctx.ref.projectDir,
        seat: ctx.seat,
        runner: ctx.runner,
        config: ctx.config,
        // The context only decides the move here; the halt names the fallback with its own cache.
        modelCache: undefined,
        signal: ctx.signal,
        implementerProfile: ctx.profile,
      });
      return automaticSeatSwitch(seatSwap, state.seatSwitches) === undefined;
    },
    wait: async (deadline) => {
      const resumed = await waitForSeatReset({
        ref: ctx.ref,
        state,
        wait: {
          seat: ctx.seat,
          resetAt: deadline.toISOString(),
          tool: getRunnerDisplayName(ctx.runner),
          kind: ctx.runner.kind,
          holds: heldSeatOf(ctx.runner, ctx.profile),
        },
        ...(ctx.signal !== undefined && { signal: ctx.signal }),
      });
      ctx.onStateChange?.(resumed);
    },
  });
}

type ThrownSeatAnswer<T> = Readonly<{ answer: T }> | Readonly<{ thrown: unknown }>;

function throwingAttempt<T>(
  call: (signal: AbortSignal) => Promise<T>,
): (signal: AbortSignal) => Promise<SeatAttempt<ThrownSeatAnswer<T>>> {
  return async (signal) => {
    try {
      return { ok: true, value: { answer: await call(signal) } };
    } catch (thrown) {
      return { ok: false, failure: seatFailureFromError(thrown), value: { thrown } };
    }
  };
}

function answerOrThrow<T>(attempt: SeatAttempt<ThrownSeatAnswer<T>>): T {
  if ('thrown' in attempt.value) throw attempt.value.thrown;
  return attempt.value.answer;
}

/**
 * A seat call that throws its failure, under `runSeatCall`: what it returns is the seat's answer,
 * and what it throws is retried, waited out, or rethrown unchanged once the ladder gives up.
 */
export async function runThrowingSeatCall<T>(
  ctx: SeatCallContext,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // A thrown call carries no usage to keep.
  return answerOrThrow(await runSeatCall(ctx, throwingAttempt(call), () => {}));
}

/**
 * The seat call of a one-shot command (`splitbrief spec`, `splitbrief review`):
 * a transient failure retries with backoff and a named usage-limit reset is
 * waited out once. There is no saved state to park on a wait and no fallback
 * seat to consider, so `write` receives the retry and wait lines instead.
 */
export async function runCommandSeatCall<T>(
  opts: Readonly<{ tool: string; write: (line: string) => void }>,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return answerOrThrow(
    await seatCallLadder(throwingAttempt(call), () => {}, {
      onRetry: (info) => opts.write(seatRetrySentence(info)),
      waits: async () => true,
      wait: async (deadline) => {
        const line = seatWaitSentence(opts.tool, deadline.toISOString());
        if (line !== null) opts.write(line);
        await abortableDelay(deadline.getTime() - Date.now(), undefined);
      },
    }),
  );
}

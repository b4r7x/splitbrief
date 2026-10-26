import {
  getRunnerDisplayName,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { readImplementerProfileConfig } from '../../../core/config/accessors/implementer-profiles.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import type { Config } from '../../../core/schemas/config.js';
import type { HeldSeat, SeatWait, WorkflowState } from '../../../core/schemas/workflow.js';
import { loadState } from '../../../core/state/persistence.js';
import { thrownSeatFailure } from '../../implementers/pipeline/call-result.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import { classifySeatFailure } from '../../runners/seat-failure.js';
import {
  abortableDelay,
  withSeatRetry,
  type SeatAttempt,
  type SeatFailure,
} from '../../runners/transient.js';
import { parseUsageLimitReset } from '../../runners/usage-limit.js';
import { publishSeatRetry, publishSeatWaitStarted } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import type { WorkflowPersistenceContext } from '../types.js';

export type SeatCallContext = Readonly<{
  ref: WorkflowPersistenceContext;
  /** The state the call starts on; the wait re-reads the persisted head before it writes. */
  state: WorkflowState;
  seat: CrewSeatId;
  /** The runner the call runs on, which a wait for its reset names. */
  runner: RunnerConfig;
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
 * The reset a limit failure named, when the run can afford to wait for it: no
 * more than `BOUNDS.rateLimitResetWaitMs` away. Only a usage-limit failure can
 * earn a wait; an outcome that names something else, or an unreported outcome
 * whose words do not read as a limit, returns undefined and the caller keeps
 * the runner-usage-limit halt with the seat picker.
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
  if (waitMs <= 0 || waitMs > BOUNDS.rateLimitResetWaitMs) return undefined;
  return resetAt;
}

/** The runner's own words out of a thrown call error, for the classifier. */
export function seatFailureFromError(err: unknown): SeatFailure {
  return { message: thrownSeatFailure(err).words };
}

/**
 * Park the seat on the persisted wait, publish it, wait until the deadline,
 * then release it. An abort leaves `state.seatWait` in place, so a resume reads
 * the deadline back and keeps waiting before the task continues.
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
    input.wait.seat,
    input.wait.resetAt,
  );
  await abortableDelay(new Date(input.wait.resetAt).getTime() - Date.now(), input.signal);
  state = transitionAndSave(input.ref, state, { type: 'CLEAR_SEAT_WAIT' });
  return state;
}

function heldSeatOf(runner: RunnerConfig, profile: string | undefined): HeldSeat {
  return {
    tool: getRunnerDisplayName(runner),
    kind: runner.kind,
    ...(profile !== undefined && { profile }),
  };
}

/**
 * The seat a config runs for a wait: the BUILD profile the wait names, else the default one, and
 * the planner for a REVIEW seat with no reviewer. A BUILD profile the config no longer has runs none.
 */
export function configuredHeldSeat(
  config: Config,
  seat: CrewSeatId,
  profile: string | undefined,
): HeldSeat | undefined {
  const runner =
    seat === 'build'
      ? readImplementerProfileConfig(config, profile)
      : readActiveRunner({ config, role: CREW_SEAT_ROLES[seat] });
  return runner === undefined ? undefined : heldSeatOf(runner, profile);
}

/** Whether a seat runs on a runner; a runner recorded without its kind matches any kind. */
function runsOn(
  seat: HeldSeat | undefined,
  runner: Readonly<{ tool?: string | undefined; kind?: HeldSeat['kind'] | undefined }>,
): boolean {
  return (
    seat !== undefined &&
    seat.tool === runner.tool &&
    (runner.kind === undefined || seat.kind === runner.kind)
  );
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
  const held = wait.holds;
  const runs =
    held === undefined ? undefined : configuredHeldSeat(input.config, wait.seat, held.profile);
  const moved = held !== undefined && !runsOn(runs, held) && !runsOn(runs, wait);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now() || moved) {
    return transitionAndSave(input.ref, input.state, { type: 'CLEAR_SEAT_WAIT' });
  }
  return waitForSeatReset({
    ref: input.ref,
    state: input.state,
    wait,
    ...(input.signal !== undefined && { signal: input.signal }),
  });
}

/**
 * One seat call with the whole seat-trouble ladder around it: a transient
 * failure retries with backoff, a limit with a near reset is waited out once
 * and the same call repeats, and a longer or unknown reset comes back as the
 * failure the caller halts on. None of these retries is a lineage attempt — no
 * state transition counts them. `onDiscarded` receives every attempt value a
 * retry or the wait replaced, so the caller can keep its usage.
 */
export async function runSeatCall<T>(
  ctx: SeatCallContext,
  call: (signal: AbortSignal) => Promise<SeatAttempt<T>>,
  onDiscarded: (value: T) => void,
): Promise<SeatAttempt<T>> {
  const attempt = (): Promise<SeatAttempt<T>> =>
    withSeatRetry(call, {
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
      onRetry: (info) =>
        publishSeatRetry({ bus: ctx.ref.bus, phase: ctx.state.phase }, { seat: ctx.seat, ...info }),
      onDiscarded,
    });

  const first = await attempt();
  if (first.ok) return first;
  const deadline = seatResetWaitDeadline(first.failure);
  if (deadline === undefined) return first;
  onDiscarded(first.value);
  const resumed = await waitForSeatReset({
    ref: ctx.ref,
    state: ctx.state,
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
  return attempt();
}

import {
  type DeepReadonly,
  type RunnerConfig,
  getRunnerCatalogDisplayName,
} from '../../../../core/config/accessors/runner-config.js';
import { automaticSwitchUsed } from '../../../../core/crew/fallback.js';
import {
  type CrewSeatId,
  formatSeatCandidateIdentity,
  candidateIdsOf,
} from '../../../../core/crew/identity.js';
import { isSeatIdentity } from '../../../../core/crew/seat-ids.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { formatAccountCause, accountCauseAdvice } from '../../../../core/recovery/account-cause.js';
import { routeNoCredential } from '../../../../core/runners/route-auth.js';
import type { Phase, RecoveryAction } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { SeatSwitchRecord } from '../../../../core/schemas/workflow/seat.js';
import { recordedSeatIdentityInput } from '../../../providers/model/display-names.js';
import { NULL_CACHE } from '../../../providers/model/runtime-snapshot.js';
import {
  runnerAccountDisplayName,
  runnerLoginInstruction,
} from '../../../runners/seat-failure/auth.js';
import type { SeatFailureClassification } from '../../../runners/seat-failure/classify.js';
import { usageLimitAdvice } from '../../../runners/seat-failure/usage-limit.js';
import type { SeatSwapContext } from '../seat/swap-context.js';
import { haltActions, chooseRecommended } from './actions.js';
import { taskFiles, attemptDetails } from './details.js';
import { type RecoveryBuilderBase, createRecoveryIssue, compactFacts } from './issue.js';
import { switchSeatOffer, automaticSeatSwitch } from './switch-offer.js';

/**
 * What every seat-down halt carries beyond its cause: the seat, the tool's own
 * words and what the classifier made of them. A `account` classification with
 * the `auth` cause is a sign-out (`runner-unauthenticated`); every other account
 * cause and a rate-limited call halt as `runner-usage-limit`, with the cause
 * kept in `facts.cause`.
 */
export interface SeatDownRecoveryOptions extends RecoveryBuilderBase {
  seat: CrewSeatId;
  runner: DeepReadonly<RunnerConfig>;
  classification: SeatFailureClassification;
  words: string;
  requestId?: string | undefined;
  resetAt?: Date | undefined;
  task?: Task | undefined;
  phase: Phase;
  attempts?: number | undefined;
  selectedImplementerProfile?: string | undefined;
  seatSwap?: SeatSwapContext | undefined;
  /**
   * The switches this run already made, so a seat is moved to its fallback
   * automatically at most once. Absent means none.
   */
  seatSwitches?: readonly SeatSwitchRecord[] | undefined;
  /** Rows a caller adds below the halt's own (the consult advice, the seat it inherits). */
  details?: readonly string[] | undefined;
  /** The provider a refused model route has no credential for; the halt names it as doctor does. */
  routeProvider?: string | undefined;
}

/** The fallback row: the declared fallback's identity, or that the seat declares none. */
function fallbackDetail(opts: SeatDownRecoveryOptions, identity: string | undefined): string {
  if (opts.seatSwap?.fallbackReadFailed) return 'fallback: not read · config.yaml does not load';
  const fallback = opts.seatSwap?.fallback;
  if (fallback === undefined) return 'no fallback set';
  const blockedReason = opts.seatSwap?.fallbackBlockedReason;
  if (blockedReason !== undefined) return `fallback: ${identity} · not offered: ${blockedReason}`;
  if (automaticSwitchUsed(opts.seatSwitches, opts.seat)) {
    return `fallback: ${identity} · automatic switch already used in this run`;
  }
  if (
    isSeatIdentity(
      { tool: opts.runner.kind === 'cli' ? opts.runner.tool : '', model: opts.runner.model },
      fallback,
    )
  ) {
    return `fallback: ${identity} · the seat runs it now`;
  }
  return `fallback: ${identity}`;
}

/** The tool's own words, attributed to the tool, as the panel and the transcript row quote them. */
export function toolReported(tool: string, words: string): string {
  return `${tool} reported: ${words}`;
}

/** The tool's own words, attributed, with the request id when the caller parsed one out. */
function reportedDetail(displayName: string, opts: SeatDownRecoveryOptions): string {
  const requestId = opts.requestId === undefined ? '' : ` (request_id: ${opts.requestId})`;
  return toolReported(displayName, `${opts.words}${requestId}`);
}

/**
 * The one seat-down halt: a seat that cannot work ends here, on the plan, build
 * or review seat alike. A refused account and a dead sign-in raise the same halt
 * — the seat moves, waits out its reset, retries, skips the brief or ends the
 * run — so the cause, the tool's verbatim words and the fallback are stated once
 * and every caller builds through here.
 */
export function buildSeatDownIssue(opts: SeatDownRecoveryOptions): RecoveryIssue {
  const { classification } = opts;
  const fallback = opts.seatSwap?.fallback;
  const fallbackIdentity =
    fallback === undefined
      ? undefined
      : formatSeatCandidateIdentity(
          fallback,
          recordedSeatIdentityInput({
            seat: candidateIdsOf(fallback),
            role: CREW_SEAT_ROLES[opts.seat],
            cache: opts.seatSwap?.modelCache ?? NULL_CACHE,
          }).displayName,
        );
  const displayName = getRunnerCatalogDisplayName(opts.runner);
  const isAuth = classification.class === 'account' && classification.cause === 'auth';
  const reason = isAuth ? 'runner-unauthenticated' : 'runner-usage-limit';
  const resetAt =
    opts.resetAt ?? (classification.class === 'rate-limited' ? classification.resetAt : undefined);
  const offer = switchSeatOffer(opts.seatSwap);
  // An account refusal or a rate-limited call moves the seat, whatever its reset.
  const switchable = classification.class === 'account' || classification.class === 'rate-limited';
  const auto = switchable ? automaticSeatSwitch(opts.seatSwap, opts.seatSwitches) : undefined;
  const switchSeat =
    offer === undefined ? undefined : auto === undefined ? offer : { ...offer, auto };
  const actions = haltActions(reason, [
    'retry-same-worker',
    switchSeat === undefined ? undefined : 'switch-seat',
    resetAt === undefined ? undefined : 'retry-later',
    opts.task === undefined ? undefined : 'skip-current-task',
    'end-run',
  ]);
  const cause =
    classification.class === 'rate-limited'
      ? 'rate-limit'
      : classification.class === 'account' && classification.cause !== 'auth'
        ? classification.cause
        : undefined;
  const provider = opts.routeProvider;
  const holder =
    classification.class === 'account' && provider === undefined
      ? runnerAccountDisplayName(opts.runner)
      : displayName;
  const message =
    provider !== undefined && opts.runner.kind === 'cli'
      ? `${routeNoCredential(opts.runner.tool, provider)}. ${runnerLoginInstruction(opts.runner)}`
      : classification.class === 'account'
        ? classification.cause === 'auth'
          ? `${formatAccountCause('auth', holder)}. ${runnerLoginInstruction(opts.runner)}`
          : accountCauseAdvice({
              cause: classification.cause,
              tool: holder,
              seat: opts.seatSwap?.seat ?? opts.seat,
            })
        : usageLimitAdvice({ tool: displayName, seat: opts.seatSwap?.seat ?? opts.seat });
  // A seat that cannot work recommends the move that gets it working: a detected
  // seat to switch to, then a named reset's wait, then the same-seat retry.
  const preferences: RecoveryAction[] = [];
  if (offer !== undefined) preferences.push('switch-seat');
  if (resetAt !== undefined) preferences.push('retry-later');

  return createRecoveryIssue({
    id: opts.id,
    seat: opts.seat,
    reason,
    phase: opts.phase,
    task: opts.task,
    files: opts.task === undefined ? [] : taskFiles(opts.task),
    affectedTaskIds: opts.task === undefined ? [] : [opts.task.id],
    message,
    details: [
      reportedDetail(displayName, opts),
      fallbackDetail(opts, fallbackIdentity),
      ...attemptDetails(opts.attempts),
      ...(opts.details ?? []),
    ],
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(resetAt !== undefined && { resetAt: resetAt.toISOString() }),
    ...(switchSeat !== undefined && { switchSeat }),
    facts: compactFacts({
      tool: holder,
      provider,
      cause,
      providerMessage: opts.words,
      requestId: opts.requestId,
      fallback: fallbackIdentity,
      ...(resetAt !== undefined && { resetsAt: resetAt.toISOString() }),
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, preferences),
    createdAt: opts.createdAt,
  });
}

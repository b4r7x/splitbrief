import type { Config } from '../../../../core/schemas/config.js';
import type { Phase, RecoveryAction } from '../../../../core/schemas/enums.js';
import { BOUNDS } from '../../../../core/pipeline-spec/bounds.js';
import type { SeatSwitchRecord } from '../../../../core/schemas/workflow.js';
import {
  routeNoCredential,
  routeRefusal,
  type ModelRefusal,
  type RouteAuthState,
  type RouteRefusal,
} from '../../../../core/runners/route-auth.js';
import type {
  RecoveryIssue,
  SeatSwapCandidate,
  SwitchSeatOffer,
} from '../../../../core/schemas/recovery/schemas.js';
import {
  candidateIdsOf,
  formatSeatCandidateIdentity,
  isSeatIdentity,
  sameSeatCandidate,
  type CrewSeatId,
} from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { recordedSeatIdentityInput } from '../../../providers/model/display-names.js';
import { NULL_CACHE, type ModelCacheAccessor } from '../../../providers/model/resolution.js';
import { recoveryActionLabel } from '../../../../core/recovery/action-label.js';
import type {
  DeepReadonly,
  RunnerConfig,
} from '../../../../core/config/accessors/runner-config.js';
import type { SeatFailureClassification } from '../../../runners/seat-failure.js';
import { accountCauseAdvice, formatAccountCause } from '../../../../core/recovery/account-cause.js';
import {
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../../core/runners/cli-tool-catalog.js';
import { runnerRoleForActiveRole } from '../../../../core/runners/seat-roles.js';
import type { RunnerFailureOutcomeState } from '../../../runners/errors.js';
import {
  apiContextError,
  apiContextRecoveryFacts,
} from '../../../providers/api-context-diagnostic.js';
import type { FinalReviewFailure } from '../../final-review.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import {
  modelRefusalMessage,
  runnerAccountDisplayName,
  runnerAuthDisplayName,
  runnerLoginInstruction,
} from '../../../runners/auth-failure.js';
import { inputTooLargeFigures } from '../../../runners/input-limit.js';
import { inputTooLargeSentence } from './review-input.js';
import { usageLimitAdvice } from '../../../runners/usage-limit.js';
import {
  finalReviewCapCause,
  formatRecoveryHeadline,
  finalReviewFailedCause,
  finalReviewUnverifiedCause,
  leftIsolationCause,
  repositoryChangedCause,
  retryExhaustedCause,
} from '../../../../core/recovery/headline.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { stripRecoveryResetClause } from '../../../../core/recovery/reset-clock.js';
import { HAND_BACK_PANEL_CHARS } from '../../../../core/pipeline-spec/ladder.js';
import { uniqueSortedIds, uniqueSorted } from '../../../../utils/collections.js';
import { includes } from '../../../../utils/type-guards.js';
import type { RecoveryBuilderBase, TaskRecoveryContext } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import { chooseRecommended, haltActions } from './actions.js';
import { attemptDetails, summarizeValidation, taskFiles } from './details.js';

export interface ValidationRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  validationSummary?: string | undefined;
}

export interface RetryExhaustedRecoveryOptions extends ValidationRecoveryOptions {
  allowRetryOverride?: boolean | undefined;
  /** The `pre_escalation` hook's reason when the hook stopped the ladder before its tiers. */
  escalationBlockedBy?: string | undefined;
  handBack?: string | undefined;
}

export interface ContextOverflowRecoveryOptions extends RecoveryBuilderBase {
  task: Task;
  routingDecision?: RoutingDecision | undefined;
  phase?: Phase | undefined;
  selectedImplementerProfile?: string | undefined;
  estimatedTokens?: number | undefined;
  untruncatedEstimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  routingReason?: string | undefined;
}

export interface ImplementerUnavailableRecoveryOptions
  extends RecoveryBuilderBase,
    TaskRecoveryContext {
  tool?: string | undefined;
  model?: string | undefined;
  availabilityReason?: string | undefined;
}

export interface DependencyBlockedRecoveryOptions extends RecoveryBuilderBase {
  task: Task;
  blockedByTasks?: Task[] | undefined;
  blockedByTaskIds?: TaskId[] | undefined;
  phase?: Phase | undefined;
}

/**
 * What every halt a runner itself caused needs: the seat's runner, the tool's
 * own words, and — when the machine remembered another ready tool — the seat
 * the operator could move to. The shape carries no discriminant: a signed-out
 * runner, an exhausted quota, a refused command line and a brief that timed out
 * twice all halt on the same three inputs.
 */
export interface RunnerFailureRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  runner: Config['implementer'];
  toolMessage: string;
  seatSwap?: SeatSwapContext | undefined;
  /** The switches this run already made, so a seat is moved to its fallback at most once. */
  seatSwitches?: readonly SeatSwitchRecord[] | undefined;
  /**
   * The call ran in the checkout itself (`workflow.isolation: none`): nothing is
   * promoted there, and the attempt's files were put back with the bytes they
   * replaced saved in `revertedDir`.
   */
  inPlace?: { revertedDir: string } | undefined;
}

/**
 * One row of the discovery snapshot as the recovery context carries it: a tool
 * the machine detected for this seat, whether that detection came back ready to
 * run, and the model, effort and variant when the row is the seat's declared
 * fallback rather than a bare detection.
 */
export type DetectedSeatTool = Readonly<{
  tool: string;
  model?: string | undefined;
  effort?: SeatSwapCandidate['effort'];
  variant?: string | undefined;
  ready: boolean;
}>;

/**
 * What a seat-down halt needs to offer a swap: which seat went down, the
 * identity it was on, the detection snapshot to pick a replacement from, and —
 * when the seat declared a fallback the last readiness pass cannot run — why
 * that fallback is not offered. A declared fallback the snapshot saw ready or
 * unverified leads `detectedTools`, so the offer lists it first.
 */
export type SeatSwapContext = Readonly<{
  seat: CrewSeatId;
  currentTool: string;
  currentModel?: string | undefined;
  modelCache?: ModelCacheAccessor | undefined;
  detectedTools: readonly DetectedSeatTool[];
  fallback?: SeatSwapCandidate | undefined;
  fallbackBlockedReason?: string | undefined;
  fallbackReadFailed?: true | undefined;
  /**
   * The config document's hash as the halt read it. The automatic-switch intent
   * records it so the engine can refuse to move a seat whose config changed
   * underneath it.
   */
  configRevision?: string | undefined;
  /**
   * What the halted seat's model route means, from the tool's own credential
   * listing and model catalog, both read fresh on a model refusal.
   * It tells a route refusal that is a sign-out from a model the tool cannot
   * serve. Absent for a seat no CLI tool hosts.
   */
  routeAuth?: RouteAuthState | undefined;
}>;

/**
 * The ready tools this seat could move to, current identity excluded, each
 * identity named once, and only tools the seat's own role admits — the seat's
 * schema would refuse the rest after the operator picked one. Returns undefined —
 * never an empty offer — when the machine has nothing else detected, so the
 * caller omits the action entirely.
 */
export function switchSeatOffer(context: SeatSwapContext | undefined): SwitchSeatOffer | undefined {
  if (context === undefined) return undefined;
  const hostable = seatHostableTools(context.seat);
  const seen = new Set<string>();
  const candidates: SeatSwapCandidate[] = [];
  for (const detected of context.detectedTools) {
    if (!detected.ready) continue;
    if (!includes(hostable, detected.tool)) continue;
    if (isSeatIdentity({ tool: context.currentTool, model: context.currentModel }, detected))
      continue;
    const identity = `${detected.tool}\u0000${detected.model ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push({
      tool: detected.tool,
      ...(detected.model !== undefined && { model: detected.model }),
      ...(detected.effort !== undefined && { effort: detected.effort }),
      ...(detected.variant !== undefined && { variant: detected.variant }),
    });
  }
  if (candidates.length === 0) return undefined;
  return { seat: context.seat, candidates };
}

function seatHostableTools(seat: CrewSeatId): readonly string[] {
  return runnerRoleForActiveRole(CREW_SEAT_ROLES[seat]) === 'implementer'
    ? IMPLEMENTER_CLI_TOOL_IDS
    : PLANNER_CLI_TOOL_IDS;
}

/**
 * A model refusal's offer: the other tools, then the seat's own tool without a
 * model, so taking it opens the seat's picker on that tool to pick a listed
 * model. It comes last, so a declared fallback still leads.
 */
function modelRefusalSeatOffer(context: SeatSwapContext | undefined): SwitchSeatOffer | undefined {
  const offer = switchSeatOffer(context);
  if (context === undefined || !includes(seatHostableTools(context.seat), context.currentTool)) {
    return offer;
  }
  return {
    seat: context.seat,
    candidates: [...(offer?.candidates ?? []), { tool: context.currentTool }],
  };
}

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
  maxAttempts?: number | undefined;
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
  if ((opts.seatSwitches ?? []).some((record) => record.seat === opts.seat && record.auto)) {
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
 * The automatic-switch intent a seat-down halt carries: the seat moves itself to
 * its declared fallback without asking. Only a seat that cannot work qualifies —
 * an account refusal, or a rate-limited call whose reset is further away than a
 * run will wait — and only when the offer leads with that fallback and this run
 * has not already switched the seat automatically. The config hash travels with
 * the intent so a config the operator changed is not overwritten.
 */
function autoSwitchIntent(
  opts: SeatDownRecoveryOptions,
  offer: SwitchSeatOffer,
): NonNullable<SwitchSeatOffer['auto']> | undefined {
  const fallback = opts.seatSwap?.fallback;
  const configRevision = opts.seatSwap?.configRevision;
  if (fallback === undefined || configRevision === undefined) return undefined;
  if ((opts.seatSwitches ?? []).some((record) => record.seat === offer.seat && record.auto)) {
    return undefined;
  }
  const classification = opts.classification;
  const switchable =
    classification.class === 'account' ||
    (classification.class === 'rate-limited' &&
      classification.resetAt.getTime() - Date.now() > BOUNDS.rateLimitResetWaitMs);
  if (!switchable) return undefined;
  const first = offer.candidates[0];
  if (first === undefined || !sameSeatCandidate(first, fallback)) return undefined;
  return { candidate: fallback, configRevision };
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
  const displayName = runnerAuthDisplayName(opts.runner);
  const isAuth = classification.class === 'account' && classification.cause === 'auth';
  const reason = isAuth ? 'runner-unauthenticated' : 'runner-usage-limit';
  const resetAt =
    opts.resetAt ?? (classification.class === 'rate-limited' ? classification.resetAt : undefined);
  const offer = switchSeatOffer(opts.seatSwap);
  const auto = offer === undefined ? undefined : autoSwitchIntent(opts, offer);
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
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...(opts.details ?? []),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
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

/**
 * The error row a runner halt publishes: its message, then the runner's own
 * words, attributed to the tool as the panel attributes them. A reset the halt
 * records is dropped from those words: the row spells it from `resetAt`, so one
 * instant is spelled once.
 */
export function runnerHaltRow(issue: RecoveryIssue, tool: string, toolMessage: string): string {
  if (issue.switchSeat?.auto !== undefined) return formatRecoveryHeadline(issue);
  const words = issue.resetAt === undefined ? toolMessage : stripRecoveryResetClause(toolMessage);
  return `${issue.message} (${toolReported(tool, words)})`;
}

/**
 * The error row a runner defect halt publishes: its message. A route sign-out
 * the missing-model builder raised reads as every other sign-out row does.
 */
export function runnerDefectRow(issue: RecoveryIssue, tool: string, toolMessage: string): string {
  return issue.reason === 'runner-unauthenticated'
    ? runnerHaltRow(issue, tool, toolMessage)
    : issue.message;
}

/** The error a retry-exhausted brief stopped on; a denial or a no-change message is not a check result. */
function lastErrorDetail(validation: ReturnType<typeof summarizeValidation>): string {
  return `Last error: ${validation.summary}`;
}

/** The end of a hand-back, where an implementer that stopped says why. */
function handBackQuote(handBack: string): string {
  const collapsed = handBack.trim().replace(/\s+/g, ' ');
  return collapsed.length <= HAND_BACK_PANEL_CHARS
    ? collapsed
    : `…${collapsed.slice(collapsed.length - HAND_BACK_PANEL_CHARS)}`;
}

export function buildRetryExhaustedRecoveryIssue(
  opts: RetryExhaustedRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'escalating';
  const validation = summarizeValidation(opts);
  const actions = haltActions('retry-exhausted', [
    opts.allowRetryOverride ? 'retry-same-worker' : undefined,
    'skip-current-task',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'retry-exhausted',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: retryExhaustedCause({
      task: opts.task.id,
      hookReason: opts.escalationBlockedBy,
    }),
    details: [
      lastErrorDetail(validation),
      ...(opts.attempts === 0 ? [] : attemptDetails(opts.attempts, opts.maxAttempts)),
      ...(opts.handBack ? [`Implementer said: ${handBackQuote(opts.handBack)}`] : []),
    ],
    attempts: opts.attempts,
    maxAttempts: opts.maxAttempts,
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      validationSummary: validation.summary,
      allowRetryOverride: opts.allowRetryOverride,
      escalationBlockedBy: opts.escalationBlockedBy,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

function contextDetails(opts: {
  estimatedTokens?: number | undefined;
  untruncatedEstimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  routingReason?: string | undefined;
}): string[] {
  return [
    opts.estimatedTokens !== undefined
      ? `Estimated prompt: ${opts.estimatedTokens} tokens`
      : undefined,
    opts.untruncatedEstimatedTokens !== undefined
      ? `Untruncated estimate: ${opts.untruncatedEstimatedTokens} tokens`
      : undefined,
    opts.contextLength !== undefined ? `Context limit: ${opts.contextLength} tokens` : undefined,
    opts.routingReason !== undefined ? `Routing: ${opts.routingReason}` : undefined,
  ].filter((detail) => detail !== undefined);
}

function rejectedProfileDetails(routing: RoutingDecision | undefined): string[] {
  if (!routing || routing.rejected.length === 0) return [];
  const rejected = routing.rejected
    .map((profile) => `${profile.profile}: ${profile.reason}`)
    .join('; ');
  return [`Rejected profiles: ${rejected}`];
}

export function buildContextOverflowRecoveryIssue(
  opts: ContextOverflowRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const routing = opts.routingDecision;
  const estimatedTokens = opts.estimatedTokens ?? routing?.estimatedTokens;
  const untruncatedEstimatedTokens =
    opts.untruncatedEstimatedTokens ?? routing?.untruncatedEstimatedTokens;
  const contextLength = opts.contextLength ?? routing?.contextLength;
  const routingReason = opts.routingReason ?? routing?.reason;
  const selectedImplementerProfile = opts.selectedImplementerProfile ?? routing?.selectedProfile;
  const actions = haltActions('context-overflow', [
    'retry-same-worker',
    'skip-current-task',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'context-overflow',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} does not fit a capable implementer context`,
    details: [
      ...contextDetails({
        estimatedTokens,
        untruncatedEstimatedTokens,
        contextLength,
        routingReason,
      }),
      ...rejectedProfileDetails(routing),
    ],
    selectedImplementerProfile,
    facts: compactFacts({
      estimatedTokens,
      untruncatedEstimatedTokens,
      contextLength,
      currentCodeTruncated: routing?.currentCodeTruncated,
      currentCodeContextMode: routing?.currentCodeContextMode,
      requiredWriteMode: routing?.requiredWriteMode,
      routingReason,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

export function buildImplementerUnavailableRecoveryIssue(
  opts: ImplementerUnavailableRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const actions = haltActions('implementation-error', [
    'retry-same-worker',
    'skip-current-task',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'implementation-error',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} selected implementer is unavailable`,
    details: [
      opts.tool !== undefined ? `Tool: ${opts.tool}` : undefined,
      opts.model !== undefined ? `Model: ${opts.model}` : undefined,
      opts.availabilityReason !== undefined
        ? `Availability: ${opts.availabilityReason}`
        : undefined,
    ].filter((detail): detail is string => detail !== undefined),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      tool: opts.tool,
      model: opts.model,
      availabilityReason: opts.availabilityReason,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

function dependencyDetail(blockedByTaskIds: TaskId[], blockedByTasks: Task[]): string {
  if (blockedByTasks.length > 0) {
    const formatted = blockedByTasks.map((task) => `${task.id} (${task.status})`).join(', ');
    return `Blocked dependencies: ${formatted}`;
  }
  if (blockedByTaskIds.length > 0) {
    return `Blocked dependencies: ${blockedByTaskIds.join(', ')}`;
  }
  return 'Blocked dependency was not identified.';
}

export function buildDependencyBlockedRecoveryIssue(
  opts: DependencyBlockedRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const blockedByTaskIds = uniqueSortedIds([
    ...(opts.blockedByTaskIds ?? []),
    ...(opts.blockedByTasks ?? []).map((task) => task.id),
  ]);
  const affectedTaskIds = uniqueSortedIds([opts.task.id, ...blockedByTaskIds]);
  const blockedFiles = (opts.blockedByTasks ?? []).map((task) => task.suggestedFiles[0]);
  const actions = haltActions('dependency-blocked', ['skip-current-task', 'end-run']);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'dependency-blocked',
    phase,
    task: opts.task,
    files: uniqueSorted([opts.task.suggestedFiles[0], ...blockedFiles], {
      trim: true,
      nonEmpty: true,
    }),
    affectedTaskIds,
    message: `${opts.task.id} is blocked by dependency status`,
    details: [dependencyDetail(blockedByTaskIds, opts.blockedByTasks ?? [])],
    facts: compactFacts({
      blockedByTaskIds: blockedByTaskIds.join(', '),
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

function runnerModel(runner: Config['implementer']): string | undefined {
  return 'model' in runner ? runner.model : undefined;
}

/** Why a refused command line or a refused model halts at once, on every seat. */
export function refusalStopDetail(refusal: ModelRefusal | undefined): string {
  return `The run stopped instead of spending retries on ${refusal === undefined ? 'a command the tool cannot accept' : 'a model the tool refuses'}.`;
}

/**
 * A refused command line or a refused model (`refusal`): both halt as
 * `implementer-recipe-invalid`, and the `refusal` fact tells the headline which.
 */
function recipeHaltIssue(
  opts: RunnerFailureRecoveryOptions,
  message: string,
  seatSwap: SwitchSeatOffer | undefined,
  refusal?: ModelRefusal,
): RecoveryIssue {
  const displayName = runnerAuthDisplayName(opts.runner);
  const actions = haltActions('implementer-recipe-invalid', [
    'retry-same-worker',
    seatSwap === undefined ? undefined : 'switch-seat',
    'end-run',
  ]);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'implementer-recipe-invalid',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message,
    details: [
      toolReported(displayName, opts.toolMessage),
      refusalStopDetail(refusal),
      ...attemptDetails(opts.attempts, opts.maxAttempts),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({
      tool: displayName,
      model: runnerModel(opts.runner),
      recipeMessage: opts.toolMessage,
      refusal,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['switch-seat']),
    createdAt: opts.createdAt,
  });
}

/**
 * The tool refused the command line SPLITBRIEF built for it — an unknown flag
 * or an argv shape the installed version does not accept. Retrying spends
 * attempts on the same rejection, so the recipe is fixed before the run moves.
 */
export function buildRecipeInvalidRecoveryIssue(opts: RunnerFailureRecoveryOptions): RecoveryIssue {
  const displayName = runnerAuthDisplayName(opts.runner);
  return recipeHaltIssue(
    opts,
    `${displayName} rejected the command SPLITBRIEF built for it`,
    switchSeatOffer(opts.seatSwap),
  );
}

/**
 * What a model refusal means for the halted seat: the one decision every
 * missing-model halt reads. OpenCode refuses a route with no credential and a
 * misspelled model, an unavailable variant or a broken provider setup alike
 * (`provider.no-route`), so the words never decide alone: the route's own
 * credential listing does. A seat with no listing to ask reads as a model the
 * tool does not list.
 */
export function seatRouteRefusal(seatSwap: SeatSwapContext | undefined): RouteRefusal {
  return seatSwap?.routeAuth === undefined
    ? { kind: 'wrong-model' }
    : routeRefusal(seatSwap.routeAuth);
}

/**
 * The offer and the message of a model refusal that is not a sign-out. Another
 * seat is the recommended move, never a retry: every attempt reaches the same
 * refusal until the seat names a listed model.
 */
export function modelRefusalHalt(
  runner: DeepReadonly<RunnerConfig>,
  refusal: ModelRefusal,
  seatSwap: SeatSwapContext | undefined,
): Readonly<{ message: string; offer: SwitchSeatOffer | undefined }> {
  return { message: modelRefusalMessage(runner, refusal), offer: modelRefusalSeatOffer(seatSwap) };
}

/**
 * A model the tool does not list is a recipe defect, not a transient failure.
 * On a route with no credential the same refusal is the seat-down sign-out.
 */
export function buildMissingModelRecoveryIssue(opts: RunnerFailureRecoveryOptions): RecoveryIssue {
  const refusal = seatRouteRefusal(opts.seatSwap);
  if (refusal.kind === 'signed-out') {
    return buildSeatDownIssue({
      id: opts.id,
      seat: 'build',
      runner: opts.runner,
      classification: { class: 'account', cause: 'auth' },
      words: opts.toolMessage,
      routeProvider: refusal.provider,
      task: opts.task,
      phase: opts.phase ?? 'implementing',
      attempts: opts.attempts,
      maxAttempts: opts.maxAttempts,
      selectedImplementerProfile: opts.selectedImplementerProfile,
      seatSwap: opts.seatSwap,
      seatSwitches: opts.seatSwitches,
      createdAt: opts.createdAt,
    });
  }
  const halt = modelRefusalHalt(opts.runner, refusal.kind, opts.seatSwap);
  return recipeHaltIssue(opts, halt.message, halt.offer, refusal.kind);
}

/**
 * Two timeouts in a row on one brief mean the slice does not fit the deadline,
 * not that the attempt was unlucky. Escalating would hand the same oversized
 * slice to the planner, so the ladder halts here.
 */
export function buildRepeatedTimeoutRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  const displayName = runnerAuthDisplayName(opts.runner);
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const actions = haltActions('runner-timeout-repeated', [
    'retry-same-worker',
    seatSwap === undefined ? undefined : 'switch-seat',
    'skip-current-task',
    'end-run',
  ]);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'runner-timeout-repeated',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${displayName} timed out twice in a row on ${opts.task.id}`,
    details: [
      toolReported(displayName, opts.toolMessage),
      'The run stopped instead of escalating a brief the implementer cannot finish in time.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({
      tool: displayName,
      timeoutMessage: opts.toolMessage,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['switch-seat']),
    createdAt: opts.createdAt,
  });
}

/**
 * A halt on what the isolation checks found around one implementer call.
 * The checkout gets nothing until Apply, or, in checkout mode, gets the attempt's
 * edits put back, so the brief halts on the evidence
 * instead of retrying into the same place. The evidence rides in the message,
 * the one line the headless sinks print, and the panel states it once: in the
 * details under its shorter header, or, for a checkout halt, as the `changes`
 * fact its header carries. The attempt count is left out, because no retry was
 * spent on it.
 */
function isolationHaltIssue(
  opts: RunnerFailureRecoveryOptions,
  halt: {
    reason: 'implementer-left-isolation' | 'checkout-changed';
    message: string;
    files: string[];
    details: readonly string[];
    changes?: string;
    actions: RecoveryAction[];
  },
  seatSwap: SwitchSeatOffer | undefined,
): RecoveryIssue {
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: halt.reason,
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: halt.files,
    affectedTaskIds: [opts.task.id],
    message: halt.message,
    details: [...halt.details],
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({ tool: runnerAuthDisplayName(opts.runner), changes: halt.changes }),
    availableActions: halt.actions,
    recommendedAction: chooseRecommended(halt.actions),
    createdAt: opts.createdAt,
  });
}

/** A tool call named a path the implementer may not reach, and the call was stopped. */
export function buildLeftIsolationRecoveryIssue(opts: RunnerFailureRecoveryOptions): RecoveryIssue {
  const evidence = `${runnerAuthDisplayName(opts.runner)} ${opts.toolMessage}`;
  const seatSwap = switchSeatOffer(opts.seatSwap);
  return isolationHaltIssue(
    opts,
    {
      reason: 'implementer-left-isolation',
      message: `${leftIsolationCause(opts.task.id)}${SOFT_SEP}${evidence}`,
      files: taskFiles(opts.task),
      details: [
        evidence,
        opts.inPlace === undefined
          ? "Your checkout gets the run's changes only through Apply."
          : `SPLITBRIEF put back what this attempt changed in your checkout; the bytes it replaced are in ${opts.inPlace.revertedDir}.`,
      ],
      actions: haltActions('implementer-left-isolation', [
        'retry-same-worker',
        seatSwap === undefined ? undefined : 'switch-seat',
        'skip-current-task',
        'end-run',
      ]),
    },
    seatSwap,
  );
}

/**
 * The repository's git state changed while the call ran. The audit sees what
 * changed, not who changed it — a commit of yours or a branch another session
 * creates lands here as readily as a tool's — so the words name the repository,
 * never the implementer. The halt is about git state, so it lists no brief file.
 */
export function buildCheckoutChangedRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  return isolationHaltIssue(
    opts,
    {
      reason: 'checkout-changed',
      message: repositoryChangedCause(opts.task.id, opts.toolMessage),
      files: [],
      changes: opts.toolMessage,
      details: [
        `Changed while ${runnerAuthDisplayName(opts.runner)} ran; the audit cannot tell who made the change.`,
        opts.inPlace === undefined
          ? "Your checkout gets the run's changes only through Apply, and nothing in your checkout was reverted."
          : `SPLITBRIEF put back the files this attempt changed in your checkout (the bytes it replaced are in ${opts.inPlace.revertedDir}); the git change stays for you to check.`,
      ],
      actions: haltActions('checkout-changed', [
        'retry-same-worker',
        'skip-current-task',
        'end-run',
      ]),
    },
    undefined,
  );
}

/**
 * The prompt SPLITBRIEF built for the implementer is larger than its tool
 * accepts. Every retry sends the same prompt, so the ladder stops and the
 * operator narrows the brief or ends the run. The message reuses the review
 * input-cap wording, named for the implementer's own tool.
 */
export function buildRunnerInputTooLargeRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  const displayName = runnerAuthDisplayName(opts.runner);
  const figures = inputTooLargeFigures(opts.toolMessage);
  const chars = figures.chars ?? opts.toolMessage.length;
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const actions = haltActions('context-overflow', [
    seatSwap === undefined ? undefined : 'switch-seat',
    'skip-current-task',
    'end-run',
  ]);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'context-overflow',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: inputTooLargeSentence(
      'Implementer input',
      { chars, maxChars: figures.maxChars },
      displayName,
    ),
    details: [
      toolReported(displayName, opts.toolMessage),
      'A retry sends the same prompt. Narrow the brief or end the run.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({
      tool: displayName,
      chars,
      maxChars: figures.maxChars ?? undefined,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['switch-seat']),
    createdAt: opts.createdAt,
  });
}

const RUNNER_DEFECT_BUILDERS: Partial<
  Record<RunnerFailureOutcomeState, (opts: RunnerFailureRecoveryOptions) => RecoveryIssue>
> = {
  'implementer-recipe-invalid': buildRecipeInvalidRecoveryIssue,
  'implementer-left-isolation': buildLeftIsolationRecoveryIssue,
  'checkout-changed': buildCheckoutChangedRecoveryIssue,
  'missing-model': buildMissingModelRecoveryIssue,
  'runner-timeout-repeated': buildRepeatedTimeoutRecoveryIssue,
  'input-too-large': buildRunnerInputTooLargeRecoveryIssue,
};

/**
 * The one table of outcomes a runner defect raises straight to recovery, keyed
 * by the outcome the runner reported. Every caller that halts on one — the
 * first attempt and every rung of the ladder — reads its builder from here, so
 * a fourth outcome is remembered once instead of in each of them.
 */
export function recoveryBuilderForRunnerOutcome(
  outcome: RunnerFailureOutcomeState,
): ((opts: RunnerFailureRecoveryOptions) => RecoveryIssue) | undefined {
  return RUNNER_DEFECT_BUILDERS[outcome];
}

export interface ApprovalDeniedRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  deniedFiles?: readonly string[] | undefined;
  denialReason?: string | undefined;
  tool?: string | undefined;
}

/** The operator refused the brief's writes; the run waits rather than retrying into the same gate. */
export function buildApprovalDeniedRecoveryIssue(
  opts: ApprovalDeniedRecoveryOptions,
): RecoveryIssue {
  const denied = opts.deniedFiles ?? [];
  const actions = haltActions('approval-denied', [
    'retry-same-worker',
    'skip-current-task',
    'end-run',
  ]);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'approval-denied',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: denied.length > 0 ? [...denied] : taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} was denied at the approval gate`,
    details: [
      opts.denialReason !== undefined ? `Denied: ${opts.denialReason}` : undefined,
      denied.length > 0 ? `Blocked files: ${denied.join(', ')}` : undefined,
      ...attemptDetails(opts.attempts, opts.maxAttempts),
    ].filter((detail): detail is string => detail !== undefined),
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    facts: compactFacts({ tool: opts.tool, denialReason: opts.denialReason }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

export interface SnapshotFailedRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  detail: string;
}

/**
 * Without a task-start snapshot the run cannot tell the implementer's writes
 * from the operator's, so drift and revert both stop working. The run halts
 * before the brief instead of running blind.
 */
export function buildSnapshotFailedRecoveryIssue(
  opts: SnapshotFailedRecoveryOptions,
): RecoveryIssue {
  const actions = haltActions('snapshot-failed', ['retry-same-worker', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'snapshot-failed',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} could not capture its task-start snapshot`,
    details: [opts.detail, 'Scope and revert cannot be enforced without the snapshot.'],
    availableActions: actions,
    recommendedAction: 'retry-same-worker',
    createdAt: opts.createdAt,
  });
}

/** A review that judged nothing on a seat that can still run; a blocked seat halts as its runner. */
type NoVerdictReviewFailure = Exclude<
  FinalReviewFailure,
  { kind: 'seat-blocked' | 'seat-protocol-error' | 'input-too-large' }
>;

export interface ReviewFailedRecoveryOptions extends RecoveryBuilderBase {
  phase?: Phase | undefined;
  /** Blocking findings the review reported. Absent when it reached no verdict at all. */
  blocking?: number | undefined;
  detail?: string | undefined;
  /** Why the review reached no verdict, when it reached none. */
  failure?: NoVerdictReviewFailure | undefined;
  /** A final review can be accepted with its open findings instead of repaired. */
  acceptAsIs?: boolean | undefined;
  /** The fix cycles spent when the cap stopped the review; fixes the halt's words. */
  fixCycles?: number | undefined;
  /** Criteria no check could verify, when the review failed with nothing to fix. */
  unverified?: number | undefined;
}

/**
 * A review that judged nothing is not a review that failed. It names no blocker
 * count, sits on the review seat rather than the briefs it never read, and is
 * re-issued once that seat has what it was missing — so it offers the retry the
 * verdict path does not. The figures stay in facts: `details[]` renders inline
 * and is truncated, and an estimate is for the details view, not the panel.
 */
function buildNoVerdictReviewIssue(
  opts: ReviewFailedRecoveryOptions,
  failure: NoVerdictReviewFailure,
): RecoveryIssue {
  const actions = haltActions('review-failed', ['retry-same-worker', 'end-run']);
  const diagnostic = failure.kind === 'insufficient-context' ? failure.diagnostic : undefined;
  const missing = diagnostic?.missingSections ?? [];
  return createRecoveryIssue({
    id: opts.id,
    seat: 'review',
    reason: 'review-failed',
    phase: opts.phase ?? 'final-review',
    files: [],
    affectedTaskIds: [],
    // One spelling of the diagnosis: the boundary that raised it words it.
    message:
      failure.kind === 'insufficient-context'
        ? apiContextError(failure.diagnostic).message
        : failure.message,
    details: [
      ...(missing.length > 0 ? [`Missing: ${missing.join(', ')}`] : []),
      ...(opts.detail === undefined ? [] : [opts.detail]),
      ...(diagnostic === undefined
        ? []
        : [
            `Pick a review seat with a larger context in /crew review, then choose ${recoveryActionLabel('retry-same-worker')}.`,
          ]),
    ],
    facts: compactFacts({
      reviewFailureKind: failure.kind,
      ...(diagnostic === undefined ? {} : apiContextRecoveryFacts(diagnostic)),
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

/**
 * The final review still reports blocking findings after the fix cycles ran out. The operator
 * can send them back through one more cycle with a correction of their own (`revise`).
 */
export function buildReviewFailedRecoveryIssue(opts: ReviewFailedRecoveryOptions): RecoveryIssue {
  if (opts.failure !== undefined) return buildNoVerdictReviewIssue(opts, opts.failure);
  const blocking = opts.blocking ?? 0;
  const actions = haltActions('review-failed', [
    'revise',
    opts.acceptAsIs === true ? 'accept-as-is' : undefined,
    'end-run',
  ]);
  const message =
    opts.fixCycles !== undefined
      ? finalReviewCapCause(opts.fixCycles)
      : opts.unverified !== undefined
        ? finalReviewUnverifiedCause(opts.unverified)
        : finalReviewFailedCause(blocking);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'review-failed',
    phase: opts.phase ?? 'final-review',
    files: [],
    affectedTaskIds: [],
    message,
    details: [opts.detail].filter((detail): detail is string => detail !== undefined),
    facts: compactFacts({
      blocking,
      fixCycles: opts.fixCycles,
      unverified: opts.unverified,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

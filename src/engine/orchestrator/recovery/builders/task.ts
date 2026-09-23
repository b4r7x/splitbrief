import type { Config } from '../../../../core/schemas/config.js';
import type { Phase } from '../../../../core/schemas/enums.js';
import type {
  RecoveryIssue,
  SeatSwapCandidate,
  SwitchSeatOffer,
} from '../../../../core/schemas/recovery/schemas.js';
import type { CrewSeatId } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
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
import { allowedActionsForReason } from '../../../../core/schemas/recovery/policy.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import type { ValidationResult } from '../../validation/result.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import { runnerAuthDisplayName, runnerLoginInstruction } from '../../../runners/auth-failure.js';
import { parseUsageLimitReset, usageLimitGuidance } from '../../../runners/usage-limit.js';
import { parseHintVerdict, type HintVerdictKind } from '../../../spec/prompts/escalation.js';
import { uniqueSortedIds, uniqueSorted } from '../../../../utils/collections.js';
import { includes } from '../../../../utils/type-guards.js';
import type { RecoveryBuilderBase, TaskRecoveryContext } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import {
  availableActionsForReason,
  chooseRecommended,
  hasRouteBigger,
  orderedActions,
} from './actions.js';
import {
  attemptDetails,
  implementerDetails,
  routeBiggerDetails,
  summarizeValidation,
  taskFiles,
} from './details.js';

export interface ValidationRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  validationResults?: ValidationResult[] | undefined;
  validationSummary?: string | undefined;
}

export interface RetryExhaustedRecoveryOptions extends ValidationRecoveryOptions {
  allowRetryOverride?: boolean | undefined;
  message?: string | undefined;
  handBack?: string | undefined;
  plannerHint?: string | undefined;
  hintRungRan?: boolean | undefined;
  plannerVerdict?: HintVerdictKind | undefined;
}

export interface ContextOverflowRecoveryOptions extends RecoveryBuilderBase {
  task: Task;
  routingDecision?: RoutingDecision | undefined;
  phase?: Phase | undefined;
  selectedImplementerProfile?: string | undefined;
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
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
}

/**
 * One row of the discovery snapshot as the recovery context carries it: a tool
 * the machine detected for this seat, and whether that detection came back
 * ready to run.
 */
export type DetectedSeatTool = Readonly<{
  tool: string;
  model?: string | undefined;
  ready: boolean;
}>;

/**
 * What a quota-blocked seat needs to offer a swap: which seat hit the limit,
 * the tool that hit it, and the detection snapshot to pick a replacement from.
 */
export type SeatSwapContext = Readonly<{
  seat: CrewSeatId;
  currentTool: string;
  detectedTools: readonly DetectedSeatTool[];
}>;

/**
 * The ready tools this seat could move to, current one excluded, each tool named
 * once, and only tools the seat's own role admits — the seat's schema would refuse
 * the rest after the operator picked one. Returns undefined — never an empty
 * offer — when the machine has nothing else detected, so the caller omits the
 * action entirely.
 */
export function switchSeatOffer(context: SeatSwapContext | undefined): SwitchSeatOffer | undefined {
  if (context === undefined) return undefined;
  const hostable =
    runnerRoleForActiveRole(CREW_SEAT_ROLES[context.seat]) === 'implementer'
      ? IMPLEMENTER_CLI_TOOL_IDS
      : PLANNER_CLI_TOOL_IDS;
  const seen = new Set<string>();
  const candidates: SeatSwapCandidate[] = [];
  for (const detected of context.detectedTools) {
    if (!detected.ready) continue;
    if (!includes(hostable, detected.tool)) continue;
    if (detected.tool === context.currentTool) continue;
    if (seen.has(detected.tool)) continue;
    seen.add(detected.tool);
    candidates.push({
      tool: detected.tool,
      ...(detected.model !== undefined && { model: detected.model }),
    });
  }
  if (candidates.length === 0) return undefined;
  return { seat: context.seat, candidates };
}

/** The profile a limit-hit or exhausted task could be re-routed to, if any. */
export function routeBiggerProfileFromDecision(
  decision: RoutingDecision | undefined,
): string | undefined {
  if (!decision?.selectedProfile) return undefined;
  const candidate = decision.rejected.find(
    (profile) =>
      profile.fit !== 'overflow' &&
      (profile.requiredWriteMode !== 'direct' || profile.profileWriteMode === 'direct'),
  );
  return candidate?.profile;
}

/**
 * A runner that ran out of quota halts the run the same way a signed-out one
 * does: retrying cannot succeed until the limit resets, and silently
 * escalating every task to the planner is the outcome the halt exists to
 * prevent. The message names the reset time whenever the
 * tool's own diagnostic carried one; login is never suggested because it
 * cannot restore quota.
 */
export function buildRunnerUsageLimitRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const displayName = runnerAuthDisplayName(opts.runner);
  const resetsAt = parseUsageLimitReset(opts.toolMessage);
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const routeBigger = hasRouteBigger(opts);
  const actions = availableActionsForReason('runner-usage-limit', {
    switchSeat: seatSwap !== undefined,
    routeBigger,
  });

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'runner-usage-limit',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${displayName} hit its usage limit. ${usageLimitGuidance(resetsAt)}`,
    details: [
      `${displayName} reported: ${opts.toolMessage}`,
      'The run stopped instead of escalating this task to the planner.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
      ...routeBiggerDetails(opts),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(resetsAt !== null && { resetAt: resetsAt.toISOString() }),
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({
      tool: displayName,
      limitMessage: opts.toolMessage,
      resetsAt: resetsAt?.toISOString(),
      routeBiggerProfile: opts.routeBiggerProfile,
      canRouteBigger: routeBigger ? true : undefined,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, [
      'switch-seat',
      'route-bigger-worker',
      'pause-run',
    ]),
    createdAt: opts.createdAt,
  });
}

/**
 * A signed-out runner halts the run instead of escalating: retrying cannot
 * succeed, and silently routing every task to the planner is the outcome the
 * halt exists to prevent. The message carries
 * the exact login command; the details keep the tool's own words verbatim.
 */
export function buildRunnerUnauthenticatedRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const displayName = runnerAuthDisplayName(opts.runner);
  const instruction = runnerLoginInstruction(opts.runner);
  const actions = orderedActions([
    'retry-same-worker',
    'skip-current-task',
    'pause-run',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'runner-unauthenticated',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${displayName} is signed out. ${instruction}`,
    details: [
      `${displayName} reported: ${opts.toolMessage}`,
      'The run stopped instead of escalating this task to the planner.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      tool: displayName,
      loginInstruction: instruction,
      authMessage: opts.toolMessage,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['retry-same-worker', 'pause-run']),
    createdAt: opts.createdAt,
  });
}

export function buildRetryExhaustedRecoveryIssue(
  opts: RetryExhaustedRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'escalating';
  const validation = summarizeValidation(opts);
  const actions = orderedActions([
    opts.allowRetryOverride ? 'retry-same-worker' : undefined,
    hasRouteBigger(opts) ? 'route-bigger-worker' : undefined,
    'skip-current-task',
    'pause-run',
    'end-run',
  ]);
  const recommendedAction = chooseRecommended(actions, [
    'route-bigger-worker',
    'retry-same-worker',
    'pause-run',
  ]);
  const verdict = opts.plannerHint === undefined ? undefined : parseHintVerdict(opts.plannerHint);
  const diagnosis = verdict?.kind === 'brief' ? verdict.diagnosis : (opts.plannerHint ?? '');

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'retry-exhausted',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: opts.message ?? `${opts.task.id} exhausted recovery retries`,
    details: [
      validation.detail,
      ...attemptDetails(opts.attempts, opts.maxAttempts, { hintRungRan: opts.hintRungRan }),
      ...implementerDetails(opts.selectedImplementerProfile),
      ...routeBiggerDetails(opts),
      ...(opts.handBack ? [`Implementer said: ${opts.handBack}`] : []),
      ...(opts.plannerHint ? [`Planner said: ${opts.plannerHint}`] : []),
      ...(opts.plannerVerdict === 'brief'
        ? [
            diagnosis === ''
              ? 'Planner verdict: the brief itself is wrong'
              : `Planner verdict: the brief itself is wrong — ${diagnosis}`,
          ]
        : []),
    ],
    attempts: opts.attempts,
    maxAttempts: opts.maxAttempts,
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      validationStage: validation.stage,
      validationSummary: validation.summary,
      allowRetryOverride: opts.allowRetryOverride,
      canRouteBigger: hasRouteBigger(opts),
      routeBiggerProfile: opts.routeBiggerProfile,
      hintRungRan: opts.hintRungRan,
      plannerVerdict: opts.plannerVerdict,
    }),
    availableActions: actions,
    recommendedAction,
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
  const routeBiggerProfile = opts.routeBiggerProfile;
  const canRouteBigger = hasRouteBigger({
    routeBiggerProfile,
    canRouteBigger: opts.canRouteBigger,
  });
  const actions = orderedActions([
    canRouteBigger ? 'route-bigger-worker' : undefined,
    'pause-run',
    'end-run',
  ]);
  const recommendedAction = chooseRecommended(actions, ['route-bigger-worker', 'pause-run']);

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
      ...routeBiggerDetails({ routeBiggerProfile, canRouteBigger }),
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
      routeBiggerProfile,
      canRouteBigger,
    }),
    availableActions: actions,
    recommendedAction,
    createdAt: opts.createdAt,
  });
}

export function buildImplementerUnavailableRecoveryIssue(
  opts: ImplementerUnavailableRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const actions = orderedActions([
    hasRouteBigger(opts) ? 'route-bigger-worker' : undefined,
    'retry-same-worker',
    'skip-current-task',
    'pause-run',
    'end-run',
  ]);
  const recommendedAction = chooseRecommended(actions, [
    'route-bigger-worker',
    'retry-same-worker',
    'pause-run',
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
      ...implementerDetails(opts.selectedImplementerProfile),
      opts.tool !== undefined ? `Tool: ${opts.tool}` : undefined,
      opts.model !== undefined ? `Model: ${opts.model}` : undefined,
      opts.availabilityReason !== undefined
        ? `Availability: ${opts.availabilityReason}`
        : undefined,
      ...routeBiggerDetails(opts),
    ].filter((detail): detail is string => detail !== undefined),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      tool: opts.tool,
      model: opts.model,
      availabilityReason: opts.availabilityReason,
      canRouteBigger: hasRouteBigger(opts),
      routeBiggerProfile: opts.routeBiggerProfile,
    }),
    availableActions: actions,
    recommendedAction,
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
  const blockedFiles = (opts.blockedByTasks ?? []).map((task) => task.file);
  const actions = orderedActions(['skip-current-task', 'pause-run', 'end-run']);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'dependency-blocked',
    phase,
    task: opts.task,
    files: uniqueSorted([opts.task.file, ...blockedFiles], { trim: true, nonEmpty: true }),
    affectedTaskIds,
    message: `${opts.task.id} is blocked by dependency status`,
    details: [dependencyDetail(blockedByTaskIds, opts.blockedByTasks ?? [])],
    facts: compactFacts({
      blockedByTaskIds: blockedByTaskIds.join(', '),
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['pause-run']),
    createdAt: opts.createdAt,
  });
}

export interface ScopeViolationRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  undeclaredFiles: readonly string[];
  tool?: string | undefined;
}

/**
 * A direct-write implementer touched paths the brief never declared. The run
 * stops at the operator rather than promoting writes nobody asked for; the
 * retry carries the revert instruction, so `retry-same-worker` is the
 * recommendation.
 */
export function buildScopeViolationRecoveryIssue(
  opts: ScopeViolationRecoveryOptions,
): RecoveryIssue {
  const actions = orderedActions(allowedActionsForReason('scope-violation'));
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'scope-violation',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: [...opts.undeclaredFiles],
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} wrote outside its declared files`,
    details: [
      `Undeclared writes: ${opts.undeclaredFiles.join(', ')}`,
      `Declared files: ${taskFiles(opts.task).join(', ')}`,
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      tool: opts.tool,
      undeclaredFiles: opts.undeclaredFiles.join(', '),
    }),
    availableActions: actions,
    recommendedAction: 'retry-same-worker',
    createdAt: opts.createdAt,
  });
}

function runnerModel(runner: Config['implementer']): string | undefined {
  return 'model' in runner ? runner.model : undefined;
}

function recipeHaltIssue(opts: RunnerFailureRecoveryOptions, message: string): RecoveryIssue {
  const displayName = runnerAuthDisplayName(opts.runner);
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const actions = availableActionsForReason('implementer-recipe-invalid', {
    switchSeat: seatSwap !== undefined,
    routeBigger: false,
  });
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
      `${displayName} reported: ${opts.toolMessage}`,
      'The run stopped instead of spending retries on a command the tool cannot accept.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({
      tool: displayName,
      model: runnerModel(opts.runner),
      recipeMessage: opts.toolMessage,
    }),
    availableActions: actions,
    recommendedAction: 'pause-run',
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
  return recipeHaltIssue(opts, `${displayName} rejected the command SPLITBRIEF built for it`);
}

/**
 * A model the tool does not list is a recipe defect, not a transient failure:
 * every attempt reaches the same refusal until the seat names a listed model.
 */
export function buildMissingModelRecoveryIssue(opts: RunnerFailureRecoveryOptions): RecoveryIssue {
  const displayName = runnerAuthDisplayName(opts.runner);
  const model = runnerModel(opts.runner) ?? 'the configured model';
  return recipeHaltIssue(
    opts,
    `Model ${model} is not listed by ${displayName}; pick a listed model`,
  );
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
  const routeBigger = hasRouteBigger(opts);
  const actions = availableActionsForReason('runner-timeout-repeated', {
    switchSeat: seatSwap !== undefined,
    routeBigger,
  });
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
      `${displayName} reported: ${opts.toolMessage}`,
      'The run stopped instead of escalating a brief the implementer cannot finish in time.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
      ...routeBiggerDetails(opts),
    ],
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({
      tool: displayName,
      timeoutMessage: opts.toolMessage,
      routeBiggerProfile: opts.routeBiggerProfile,
      canRouteBigger: routeBigger ? true : undefined,
    }),
    availableActions: actions,
    recommendedAction: 'pause-run',
    createdAt: opts.createdAt,
  });
}

/**
 * A halt on what the isolation checks found around one implementer call.
 * Nothing the attempt wrote was promoted, so the brief halts on the evidence
 * instead of retrying into the same place. The evidence rides in the message,
 * the one line the headless sinks print, and leads the details the panel lists
 * under its shorter header; the attempt count is left out, because no retry was
 * spent on it.
 */
function isolationHaltIssue(
  opts: RunnerFailureRecoveryOptions,
  halt: {
    reason: 'implementer-left-isolation' | 'checkout-changed';
    message: string;
    details: readonly string[];
  },
): RecoveryIssue {
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const actions = availableActionsForReason(halt.reason, {
    switchSeat: seatSwap !== undefined,
    routeBigger: false,
  });
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: halt.reason,
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: halt.message,
    details: [...halt.details, ...implementerDetails(opts.selectedImplementerProfile)],
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({ tool: runnerAuthDisplayName(opts.runner) }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['retry-same-worker', 'pause-run']),
    createdAt: opts.createdAt,
  });
}

/** A tool call named a path the implementer may not reach, and the call was stopped. */
export function buildLeftIsolationRecoveryIssue(opts: RunnerFailureRecoveryOptions): RecoveryIssue {
  const evidence = `${runnerAuthDisplayName(opts.runner)} ${opts.toolMessage}`;
  return isolationHaltIssue(opts, {
    reason: 'implementer-left-isolation',
    message: `${opts.task.id} left the isolation directory — ${evidence}`,
    details: [evidence, 'Nothing from this attempt was promoted.'],
  });
}

/**
 * The checkout's git state changed while the call ran. The audit sees what
 * changed, not who changed it — a commit of yours lands here as readily as a
 * tool's — so the words name the checkout, never the implementer.
 */
export function buildCheckoutChangedRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  return isolationHaltIssue(opts, {
    reason: 'checkout-changed',
    message: `Your checkout changed under ${opts.task.id} — ${opts.toolMessage}`,
    details: [
      `Changed while ${runnerAuthDisplayName(opts.runner)} ran: ${opts.toolMessage}`,
      'Nothing from this attempt was promoted, and nothing in your checkout was reverted.',
    ],
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
  const actions = orderedActions(allowedActionsForReason('approval-denied'));
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
    recommendedAction: 'pause-run',
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
  const actions = orderedActions(allowedActionsForReason('snapshot-failed'));
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

export interface ReviewFailedRecoveryOptions extends RecoveryBuilderBase {
  phase?: Phase | undefined;
  /** Blocking findings the review reported. Absent when it reached no verdict at all. */
  blocking?: number | undefined;
  detail?: string | undefined;
  /** Why the review reached no verdict, when it reached none. */
  failure?: FinalReviewFailure | undefined;
}

const REVIEW_SEAT_REMEDY =
  'Adjust the review seat with /crew review or Settings, then /resume and choose retry.';

/**
 * A review that judged nothing is not a review that failed. It names no blocker
 * count, sits on the review seat rather than the briefs it never read, and is
 * re-issued once that seat has what it was missing — so it offers the retry the
 * verdict path does not. The figures stay in facts: `details[]` renders inline
 * and is truncated, and an estimate is for the details view, not the panel.
 */
function buildNoVerdictReviewIssue(
  opts: ReviewFailedRecoveryOptions,
  failure: FinalReviewFailure,
): RecoveryIssue {
  const actions = orderedActions(['retry-same-worker', 'pause-run', 'end-run']);
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
      REVIEW_SEAT_REMEDY,
    ],
    facts: compactFacts({
      reviewFailureKind: failure.kind,
      ...(diagnostic === undefined ? {} : apiContextRecoveryFacts(diagnostic)),
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(
      actions,
      // A packet the seat cannot read refuses again unless the seat changes; a
      // call that never landed is worth one more turn as it stands.
      failure.kind === 'call-failed' ? ['retry-same-worker'] : ['pause-run'],
    ),
    createdAt: opts.createdAt,
  });
}

/** The final review still reports blocking findings after the fix cycles ran out. */
export function buildReviewFailedRecoveryIssue(opts: ReviewFailedRecoveryOptions): RecoveryIssue {
  if (opts.failure !== undefined) return buildNoVerdictReviewIssue(opts, opts.failure);
  const blocking = opts.blocking ?? 0;
  const actions = orderedActions(['pause-run', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'review-failed',
    phase: opts.phase ?? 'final-review',
    files: [],
    affectedTaskIds: [],
    message: `Final review failed with ${blocking} blocking finding${blocking === 1 ? '' : 's'}`,
    details: [opts.detail].filter((detail): detail is string => detail !== undefined),
    facts: compactFacts({ blocking }),
    availableActions: actions,
    recommendedAction: 'pause-run',
    createdAt: opts.createdAt,
  });
}

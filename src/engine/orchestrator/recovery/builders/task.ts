import type { Config } from '../../../../core/schemas/config.js';
import type { Phase, RecoveryAction } from '../../../../core/schemas/enums.js';
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
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import type { ValidationResult } from '../../validation/result.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import { runnerAuthDisplayName, runnerLoginInstruction } from '../../../runners/auth-failure.js';
import { inputTooLargeFigures } from '../../../runners/input-limit.js';
import { inputTooLargeSentence } from './review-input.js';
import { parseUsageLimitReset, usageLimitAdvice } from '../../../runners/usage-limit.js';
import {
  finalReviewCapCause,
  finalReviewFailedCause,
  finalReviewUnverifiedCause,
  retryExhaustedCause,
} from '../../../../core/recovery/headline.js';
import { stripRecoveryResetClause } from '../../../../core/recovery/reset-clock.js';
import { HAND_BACK_PANEL_CHARS } from '../../../../core/pipeline-spec/ladder.js';
import { uniqueSortedIds, uniqueSorted } from '../../../../utils/collections.js';
import { includes } from '../../../../utils/type-guards.js';
import type { RecoveryBuilderBase, TaskRecoveryContext } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import { chooseRecommended, haltActions } from './actions.js';
import { attemptDetails, implementerDetails, summarizeValidation, taskFiles } from './details.js';

export interface ValidationRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  validationResults?: ValidationResult[] | undefined;
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
  /**
   * The call ran in the checkout itself (`workflow.isolation: none`): nothing is
   * promoted there, and the attempt's files were put back with the bytes they
   * replaced saved in `revertedDir`.
   */
  inPlace?: { revertedDir: string } | undefined;
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

/**
 * A runner that ran out of quota halts the run the same way a signed-out one
 * does: retrying cannot succeed until the limit resets, and silently
 * escalating every task to the planner is the outcome the halt exists to
 * prevent. The halt records the reset time whenever the tool's own diagnostic
 * carried one; login is never suggested because it cannot restore quota.
 */
export function buildRunnerUsageLimitRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const displayName = runnerAuthDisplayName(opts.runner);
  const resetsAt = parseUsageLimitReset(opts.toolMessage);
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const actions = haltActions('runner-usage-limit', [
    'retry-same-worker',
    seatSwap === undefined ? undefined : 'switch-seat',
    'skip-current-task',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'runner-usage-limit',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: usageLimitAdvice({ tool: displayName, seat: 'build' }),
    details: [
      `${displayName} reported: ${opts.toolMessage}`,
      'The run stopped instead of escalating this task to the planner.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
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
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['switch-seat']),
    createdAt: opts.createdAt,
  });
}

/**
 * The error row a runner halt publishes: its message, then the runner's own
 * words. A reset the halt records is dropped from those words: the row spells
 * it from `resetAt`, so one instant is spelled once.
 */
export function runnerHaltRow(issue: RecoveryIssue, toolMessage: string): string {
  const words = issue.resetAt === undefined ? toolMessage : stripRecoveryResetClause(toolMessage);
  return `${issue.message} (runner reported: ${words})`;
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
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const actions = haltActions('runner-unauthenticated', [
    'retry-same-worker',
    seatSwap === undefined ? undefined : 'switch-seat',
    'skip-current-task',
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
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({
      tool: displayName,
      loginInstruction: instruction,
      authMessage: opts.toolMessage,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

/** The error a retry-exhausted brief stopped on; a denial or a no-change message is not a check result. */
function lastErrorDetail(validation: ReturnType<typeof summarizeValidation>): string {
  return validation.stage === undefined
    ? `Last error: ${validation.summary}`
    : `Last error: ${validation.stage} failed: ${validation.summary}`;
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
      ...implementerDetails(opts.selectedImplementerProfile),
      ...(opts.handBack ? [`Implementer said: ${handBackQuote(opts.handBack)}`] : []),
    ],
    attempts: opts.attempts,
    maxAttempts: opts.maxAttempts,
    selectedImplementerProfile: opts.selectedImplementerProfile,
    facts: compactFacts({
      validationStage: validation.stage,
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
      ...implementerDetails(opts.selectedImplementerProfile),
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

function recipeHaltIssue(opts: RunnerFailureRecoveryOptions, message: string): RecoveryIssue {
  const displayName = runnerAuthDisplayName(opts.runner);
  const seatSwap = switchSeatOffer(opts.seatSwap);
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
      `${displayName} reported: ${opts.toolMessage}`,
      'The run stopped instead of escalating a brief the implementer cannot finish in time.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
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
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: halt.message,
    details: [...halt.details, ...implementerDetails(opts.selectedImplementerProfile)],
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({ tool: runnerAuthDisplayName(opts.runner) }),
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
      message: `${opts.task.id} left the isolation directory — ${evidence}`,
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
 * The checkout's git state changed while the call ran. The audit sees what
 * changed, not who changed it — a commit of yours lands here as readily as a
 * tool's — so the words name the checkout, never the implementer.
 */
export function buildCheckoutChangedRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  return isolationHaltIssue(
    opts,
    {
      reason: 'checkout-changed',
      message: `Your checkout changed under ${opts.task.id} — ${opts.toolMessage}`,
      details: [
        `Changed while ${runnerAuthDisplayName(opts.runner)} ran: ${opts.toolMessage}`,
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
      `${displayName} reported: ${opts.toolMessage}`,
      'A retry sends the same prompt. Narrow the brief or end the run.',
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
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
      REVIEW_SEAT_REMEDY,
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

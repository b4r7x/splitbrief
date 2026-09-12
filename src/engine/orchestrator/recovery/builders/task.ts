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
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import type { ValidationResult } from '../../validation/result.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import { runnerAuthDisplayName, runnerLoginInstruction } from '../../../runners/auth-failure.js';
import { parseUsageLimitReset, usageLimitGuidance } from '../../../runners/usage-limit.js';
import { uniqueSortedIds, uniqueSorted } from '../../../../utils/collections.js';
import { includes } from '../../../../utils/type-guards.js';
import type { RecoveryBuilderBase, TaskRecoveryContext } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import { chooseRecommended, hasRouteBigger, orderedActions } from './actions.js';
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

export interface RunnerUnauthenticatedRecoveryOptions
  extends RecoveryBuilderBase,
    TaskRecoveryContext {
  runner: Config['implementer'];
  toolMessage: string;
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

export type RunnerUsageLimitRecoveryOptions = RunnerUnauthenticatedRecoveryOptions & {
  seatSwap?: SeatSwapContext | undefined;
};

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
 * does: retrying is free but cannot succeed until the limit resets, and
 * silently escalating every task to the planner is the expensive failure the
 * halt exists to prevent. The message names the reset time whenever the
 * tool's own diagnostic carried one; login is never suggested because it
 * cannot restore quota.
 */
export function buildRunnerUsageLimitRecoveryIssue(
  opts: RunnerUsageLimitRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const displayName = runnerAuthDisplayName(opts.runner);
  const resetsAt = parseUsageLimitReset(opts.toolMessage);
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const actions = orderedActions([
    'retry-same-worker',
    hasRouteBigger(opts) ? 'route-bigger-worker' : undefined,
    seatSwap !== undefined ? 'switch-seat' : undefined,
    'skip-current-task',
    'pause-run',
    'abort-workflow',
  ]);

  return createRecoveryIssue({
    id: opts.id,
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
      canRouteBigger: hasRouteBigger(opts) ? true : undefined,
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
 * A signed-out runner halts the run instead of escalating: retrying costs
 * nothing but cannot succeed, and silently routing every task to the planner
 * is the expensive failure the halt exists to prevent. The message carries
 * the exact login command; the details keep the tool's own words verbatim.
 */
export function buildRunnerUnauthenticatedRecoveryIssue(
  opts: RunnerUnauthenticatedRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const displayName = runnerAuthDisplayName(opts.runner);
  const instruction = runnerLoginInstruction(opts.runner);
  const actions = orderedActions([
    'retry-same-worker',
    'skip-current-task',
    'pause-run',
    'abort-workflow',
  ]);

  return createRecoveryIssue({
    id: opts.id,
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
    'abort-workflow',
  ]);
  const recommendedAction = chooseRecommended(actions, [
    'route-bigger-worker',
    'retry-same-worker',
    'pause-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    reason: 'retry-exhausted',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: opts.message ?? `${opts.task.id} exhausted recovery retries`,
    details: [
      validation.detail,
      ...attemptDetails(opts.attempts, opts.maxAttempts),
      ...implementerDetails(opts.selectedImplementerProfile),
      ...routeBiggerDetails(opts),
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
    'abort-workflow',
  ]);
  const recommendedAction = chooseRecommended(actions, ['route-bigger-worker', 'pause-run']);

  return createRecoveryIssue({
    id: opts.id,
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
    'abort-workflow',
  ]);
  const recommendedAction = chooseRecommended(actions, [
    'route-bigger-worker',
    'retry-same-worker',
    'pause-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
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
  const actions = orderedActions(['skip-current-task', 'pause-run', 'abort-workflow']);

  return createRecoveryIssue({
    id: opts.id,
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

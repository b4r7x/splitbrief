import { getRunnerCatalogDisplayName } from '../../../../core/config/accessors/runner-config.js';
import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import { stripRecoveryResetClause } from '../../../../core/recovery/reset-clock.js';
import type { ModelRefusal } from '../../../../core/runners/route-auth.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { RecoveryIssue, SwitchSeatOffer } from '../../../../core/schemas/recovery/schemas.js';
import {
  type PromptSize,
  inputTooLargeSentence,
  inputTooLargeFigures,
  inputTooLargeFacts,
} from '../../../runners/input-limit.js';
import { haltActions, chooseRecommended } from './actions.js';
import { taskFiles, attemptDetails } from './details.js';
import { createRecoveryIssue, compactFacts } from './issue.js';
import { buildSeatDownIssue, toolReported } from './seat-down.js';
import { switchSeatOffer, seatRouteRefusal, modelRefusalHalt } from './switch-offer.js';
import type { RunnerFailureRecoveryOptions } from './types.js';

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
  const displayName = getRunnerCatalogDisplayName(opts.runner);
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
      ...attemptDetails(opts.attempts),
    ],
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
  const displayName = getRunnerCatalogDisplayName(opts.runner);
  return recipeHaltIssue(
    opts,
    `${displayName} rejected the command SPLITBRIEF built for it`,
    switchSeatOffer(opts.seatSwap),
  );
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
  const displayName = getRunnerCatalogDisplayName(opts.runner);
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
      opts.toolMessage,
      'The run stopped instead of escalating a brief the implementer cannot finish in time.',
      ...attemptDetails(opts.attempts),
    ],
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
 * A tool that changed during the run and failed its new check. Every attempt
 * would start the same changed tool, so the brief halts on the check, and Try
 * again checks the tool again.
 */
export function buildRunnerCheckFailedRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  const displayName = getRunnerCatalogDisplayName(opts.runner);
  const seatSwap = switchSeatOffer(opts.seatSwap);
  const actions = haltActions('runner-check-failed', [
    'retry-same-worker',
    seatSwap === undefined ? undefined : 'switch-seat',
    'skip-current-task',
    'end-run',
  ]);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'runner-check-failed',
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${displayName} changed during the run and failed its check on ${opts.task.id}`,
    details: [
      opts.toolMessage,
      'The run stopped instead of starting a tool that did not pass its check.',
      ...attemptDetails(opts.attempts),
    ],
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({ tool: displayName, model: runnerModel(opts.runner) }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

/**
 * The detail of a prompt refused as too large, on every seat: its size and the limit in
 * SPLITBRIEF's words where the refusal named one, else the tool's own words when it said any.
 */
export function inputTooLargeDetail(
  figures: PromptSize,
  tool: string,
  toolWords: string | null,
  subject = 'The prompt',
): string {
  return figures.size === null && figures.limit === null && toolWords !== null
    ? toolReported(tool, toolWords)
    : `${inputTooLargeSentence(subject, figures, tool)}.`;
}

/**
 * The prompt SPLITBRIEF built for the implementer is larger than its tool
 * accepts. Every retry sends the same prompt, so the ladder stops and the
 * operator changes the tool, skips the brief or ends the run.
 */
export function buildRunnerInputTooLargeRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  const displayName = getRunnerCatalogDisplayName(opts.runner);
  const figures = inputTooLargeFigures(opts.toolMessage);
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
    message: `Prompt too large for ${displayName} on ${opts.task.id}`,
    details: [
      inputTooLargeDetail(figures, displayName, opts.toolMessage),
      'A retry sends the same prompt.',
      ...attemptDetails(opts.attempts),
    ],
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({ tool: displayName, ...inputTooLargeFacts(figures) }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['switch-seat']),
    createdAt: opts.createdAt,
  });
}

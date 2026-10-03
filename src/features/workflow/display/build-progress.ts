import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { isImplementerPhase } from '../../../core/phases.js';
import { isApiProviderId } from '../../../core/providers/api-provider-catalog.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { formatTime } from '../../../utils/format-time.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type {
  ActiveOperation,
  OperationRole,
  OperationsState,
} from '../../../stores/workflow/operations/state.js';
import { selectTaskListView, type TasksState } from '../../../stores/workflow/tasks.js';
import { inlineActiveVerb } from './phase-verb.js';

/**
 * The floor under the silence warning: the block never paints it for a seat quieter than this,
 * however early a runner is configured to warn. The watchdog's own warn decides when a stall
 * stands.
 */
export const UI_IDLE_WARN_MS = 60_000;

export type BuildProgressEta =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'estimate'; remainingMs: number };

export interface BuildProgress {
  passed: number;
  total: number;
  escalated: number;
  failed: number;
  /** `null` outside the build: the review seat runs no brief, so there is no attempt to count. */
  attempt: { current: number; max: number } | null;
  /** `null` outside the build, where no brief is left to estimate. */
  eta: BuildProgressEta | null;
  /** What the run is doing: the seat and its operation, or the gate command it is inside. */
  activity: string;
  /** How long ago it last said so. */
  freshness: string;
  /** True when the watchdog's stall makes freshness the silence warning, not the ordinary age. */
  silent: boolean;
}

export interface DeriveBuildProgressInput {
  tasks: TasksState;
  lifecycle: LifecycleState;
  operations: OperationsState;
  now: number;
}

// Calls the run makes beside the seat's own work; the phase names the seat's work, never theirs.
const SIDE_CALL_ROLES: ReadonlySet<OperationRole> = new Set<OperationRole>([
  'summary',
  'compaction',
]);

/** The tool a call ran on: the Claude runner names its calls `claude`, its command, not its id. */
function runnerTool(runnerName: string): string {
  return cliToolIdForCommand(runnerName) ?? runnerName;
}

/**
 * The worker a call ran on, as an identity two calls can be compared by. The backend kind is part
 * of that identity, so a shell command named `claude` never equals a CLI call on Claude Code or an
 * API worker of the same name. A call with no recorded kind keeps the old alias identity.
 */
function runnerIdentity(operation: ActiveOperation): string | null {
  const { backendKind, runnerName } = operation;
  if (runnerName === undefined) return null;
  if (backendKind === undefined || backendKind === 'cli') {
    return `cli:${runnerTool(runnerName)}`;
  }
  return `${backendKind}:${runnerName}`;
}

function runnerLabel(
  backendKind: ActiveOperation['backendKind'],
  runnerName: string | undefined,
): string | undefined {
  if (runnerName === undefined) return undefined;
  if (backendKind === 'api') {
    // A catalogued API provider gets its display name; a custom name stays literal.
    return isApiProviderId(runnerName) ? getProviderDisplayName(runnerName) : runnerName;
  }
  if (backendKind === 'shell' || backendKind === 'agent') return runnerName;
  return getProviderDisplayName(runnerTool(runnerName));
}

function etaFor(input: DeriveBuildProgressInput, remaining: number): BuildProgressEta {
  const { taskCompletionTimes } = input.tasks;
  if (taskCompletionTimes.length === 0) {
    return { kind: 'unavailable', reason: 'no brief finished yet' };
  }
  // An estimate built from one seat's pace says nothing about another's, so a swap retires it
  // rather than quoting a number the new worker never earned.
  const { active, last } = input.operations;
  if (
    active !== null &&
    last !== null &&
    active.runnerName !== undefined &&
    last.runnerName !== undefined &&
    runnerIdentity(active) !== runnerIdentity(last)
  ) {
    return { kind: 'unavailable', reason: 'worker changed' };
  }
  const average =
    taskCompletionTimes.reduce((sum, value) => sum + value, 0) / taskCompletionTimes.length;
  return { kind: 'estimate', remainingMs: Math.round(average * Math.max(0, remaining)) };
}

// What the run is doing, not what it has spent: usage is reported where a reader asks for it,
// through `/usage`, and never as a rounded count that reads `0k` until the first report lands.
function activityLine(input: DeriveBuildProgressInput): string {
  const stage = input.operations.validationStage ?? null;
  if (stage !== null) {
    // How long the command has run is its proof of life. When the run last heard from a seat is
    // the freshness line's to say, so the row does not say it twice.
    const command = stage.command ?? stage.stage;
    return [command, `running ${formatTime(input.now - stage.stageStartedTs)}`].join(SOFT_SEP);
  }
  const operation = input.operations.active;
  // Between calls there is no seat and no operation to name, and printing the phase twice would
  // read as two facts. The phase alone is the whole truth at that moment.
  if (operation === null) return input.lifecycle.phase;
  // The runner is named on this line already, so naming its seat too says it twice
  // ("implementer implementing"): the phase's own verb is what the seat is doing. A side call is
  // the exception — its role is the fact the phase cannot tell.
  const doing = SIDE_CALL_ROLES.has(operation.role)
    ? operation.role
    : inlineActiveVerb(operation.phase);
  return [runnerLabel(operation.backendKind, operation.runnerName) ?? input.lifecycle.phase, doing]
    .filter((part) => part !== '')
    .join(SOFT_SEP);
}

/**
 * How long the call in flight has been silent: the one span the block's freshness line and the
 * byline's stall lead both state. The watchdog's stall is the source — it survives a usage or
 * warning heartbeat that says the process is alive without saying the seat spoke — and `null`
 * means no silence warning stands. `lastRunnerEventTs` stays what it is, when the run last heard
 * anything, and is only the ordinary freshness age.
 */
export function runnerSilenceMs(lifecycle: LifecycleState, now: number): number | null {
  const stall = lifecycle.stall;
  if (stall === null) return null;
  return Math.max(0, now - stall.since + stall.silentMs);
}

// Silence is a seat's. With no call running — a gate command, the step between two calls — no one
// is expected to speak, and the quiet is only how long ago the last word was. The seat's name is
// already on the activity line beside this one, so the silence names only itself.
function freshnessOf(input: DeriveBuildProgressInput): Pick<BuildProgress, 'freshness' | 'silent'> {
  const call = input.operations.active;
  const silentMs = call === null ? null : runnerSilenceMs(input.lifecycle, input.now);
  if (silentMs !== null && silentMs >= UI_IDLE_WARN_MS) {
    return { freshness: `No update for ${formatTime(silentMs)}`, silent: true };
  }
  const lastTs = input.lifecycle.lastRunnerEventTs ?? null;
  if (lastTs === null) return { freshness: 'no update yet', silent: false };
  return { freshness: `last event ${formatTime(input.now - lastTs)} ago`, silent: false };
}

export function deriveBuildProgress(input: DeriveBuildProgressInput): BuildProgress {
  const view = selectTaskListView(input.tasks);
  const building = isImplementerPhase(input.lifecycle.phase);
  return {
    passed: view.passed,
    total: view.total,
    escalated: view.escalated,
    failed: view.failed,
    attempt: building
      ? { current: input.tasks.currentAttempt, max: BOUNDS.attemptsPerLineage }
      : null,
    eta: building ? etaFor(input, view.total - view.finished - view.failed) : null,
    activity: activityLine(input),
    ...freshnessOf(input),
  };
}

// An average of finished briefs projected onto the ones left is a guess in minutes; printing it to
// the second ("ETA 2s") claims a precision the average never had.
export function etaText(eta: BuildProgressEta): string {
  if (eta.kind === 'unavailable') return `ETA unavailable: ${eta.reason}`;
  const minutes = Math.round(eta.remainingMs / 60_000);
  return minutes === 0 ? 'ETA under a minute' : `ETA ~${minutes}m`;
}

function countsText(progress: BuildProgress): string {
  const parts = [`${progress.passed}/${progress.total} briefs passed`];
  if (progress.escalated > 0) parts.push(`${progress.escalated} escalated`);
  if (progress.failed > 0) parts.push(`${progress.failed} failed`);
  return parts.join(SOFT_SEP);
}

function rowCount(width: number, building: boolean): number {
  if (width >= 120) return 2;
  if (!building) return 3;
  if (width >= 80) return 4;
  return 5;
}

/**
 * How many rows the block occupies at a width in a phase. The chrome budgets from this without
 * knowing the rest of the run's state, so the block never paints over the body it was measured
 * around.
 */
export function buildProgressRowCount(width: number, phase: Phase): number {
  return rowCount(width, isImplementerPhase(phase));
}

/** The same facts at every width, regrouped rather than dropped. */
export function buildProgressLines(progress: BuildProgress, width: number): string[] {
  const counts = countsText(progress);
  const perAttempt =
    progress.attempt === null || progress.eta === null
      ? []
      : [`attempt ${progress.attempt.current} of ${progress.attempt.max}`, etaText(progress.eta)];
  switch (rowCount(width, perAttempt.length > 0)) {
    case 2:
      return [
        [counts, ...perAttempt].join(SOFT_SEP),
        [progress.activity, progress.freshness].join(SOFT_SEP),
      ];
    case 3:
      return [counts, progress.activity, progress.freshness];
    case 4:
      return [counts, perAttempt.join(SOFT_SEP), progress.activity, progress.freshness];
    default:
      return [counts, ...perAttempt, progress.activity, progress.freshness];
  }
}

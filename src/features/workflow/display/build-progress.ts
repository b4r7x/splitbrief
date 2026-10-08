import { isImplementerPhase } from '../../../core/phases.js';
import { isApiProviderId } from '../../../core/providers/api-provider-catalog.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { formatTime } from '../../../utils/format-time.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type {
  ActiveOperation,
  OpenTool,
  OperationRole,
  OperationsState,
} from '../../../stores/workflow/operations/state.js';
import { selectTaskListView, type TasksState } from '../../../stores/workflow/tasks.js';
import { inlineActiveVerb, suiteStageText } from './phase-verb.js';
import { stallRunnerHint } from './live-activity.js';
import { runnerActivityLedgerItem } from './runner-activity-display.js';

/**
 * The floor under the silence warning: the block never paints it for a seat quieter than this,
 * however early a runner is configured to warn. The watchdog's own warn decides when a stall
 * stands.
 */
export const UI_IDLE_WARN_MS = 60_000;

export interface BuildProgress {
  passed: number;
  total: number;
  escalated: number;
  failed: number;
  /**
   * `null` outside the build, where the review seat runs no brief, and on a brief's first attempt,
   * which is the normal case: the bound matters once a retry has spent one.
   */
  attempt: { current: number; max: number } | null;
  /** What the run is doing: the seat and its operation, or the command it is inside. */
  activity: string;
  /**
   * The proof of life: how long the command in `activity` has run, else how long ago a seat last
   * said something, or the tool it runs through a silence.
   */
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

// What the run is doing, not what it has spent: usage is reported where a reader asks for it,
// through `/usage`, and never as a rounded count that reads `0k` until the first report lands.
function activityLine(input: DeriveBuildProgressInput): string {
  const command = runningCommand(input.operations);
  if (command !== null) return command.label;
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
 * The command the run is inside: a reviewer check, its re-run at the run base, or an older
 * session's gate stage. No seat speaks while it runs, so its own clock is the block's proof of
 * life, and the age of a seat's last word would only contradict it.
 */
function runningCommand(operations: OperationsState): { label: string; startedTs: number } | null {
  const suite = operations.suiteStage ?? null;
  if (suite !== null) return { label: suiteStageText(suite), startedTs: suite.stageStartedTs };
  const stage = operations.validationStage ?? null;
  if (stage === null) return null;
  return { label: stage.command ?? stage.stage, startedTs: stage.stageStartedTs };
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

/** The last tool the call opened and has not closed, in the words the activity rows use. */
function openToolText(tool: OpenTool): string {
  const item = runnerActivityLedgerItem({ stage: 'updated', ...tool });
  return item.label === 'RUN' ? `running ${item.value}` : `${item.groupLabel} ${item.value}`;
}

// Silence is a seat's. While a command runs, its clock is the freshness. With no call running — the
// step between two calls — no one is expected to speak, and the quiet is only how long ago the last
// word was. The seat's name is
// already on the activity line beside this one, so the silence names only itself. A tool the
// stream opened and has not closed is what the seat is doing through that silence, so the line
// names it; a stream that reports a tool only once it ends cannot name it, only say one runs.
function freshnessOf(input: DeriveBuildProgressInput): Pick<BuildProgress, 'freshness' | 'silent'> {
  const command = runningCommand(input.operations);
  if (command !== null) {
    return { freshness: `running ${formatTime(input.now - command.startedTs)}`, silent: false };
  }
  const call = input.operations.active;
  const silentMs = call === null ? null : runnerSilenceMs(input.lifecycle, input.now);
  if (call !== null && silentMs !== null && silentMs >= UI_IDLE_WARN_MS) {
    const tool = call.openTools?.at(-1);
    if (tool !== undefined) {
      return {
        freshness: `${openToolText(tool)}${SOFT_SEP}${formatTime(input.now - tool.since)}`,
        silent: false,
      };
    }
    const quietStream =
      call.runnerName !== undefined &&
      stallRunnerHint(runnerTool(call.runnerName), call.backendKind) !== null;
    return {
      freshness: quietStream
        ? `a tool is running${SOFT_SEP}${formatTime(silentMs)}`
        : `No update for ${formatTime(silentMs)}`,
      silent: true,
    };
  }
  const lastTs = input.lifecycle.lastRunnerEventTs ?? null;
  if (lastTs === null) return { freshness: 'no update yet', silent: false };
  return { freshness: `last event ${formatTime(input.now - lastTs)} ago`, silent: false };
}

export function deriveBuildProgress(input: DeriveBuildProgressInput): BuildProgress {
  const view = selectTaskListView(input.tasks);
  const retrying = isImplementerPhase(input.lifecycle.phase) && input.tasks.currentAttempt >= 2;
  return {
    passed: view.passed,
    total: view.total,
    escalated: view.escalated,
    failed: view.failed,
    attempt: retrying
      ? { current: input.tasks.currentAttempt, max: input.tasks.attemptAllowance }
      : null,
    activity: activityLine(input),
    ...freshnessOf(input),
  };
}

function countsText(progress: BuildProgress): string {
  const parts = [`${progress.passed}/${progress.total} briefs passed`];
  if (progress.escalated > 0) parts.push(`${progress.escalated} escalated`);
  if (progress.failed > 0) parts.push(`${progress.failed} failed`);
  if (progress.attempt !== null) {
    parts.push(`attempt ${progress.attempt.current} of ${progress.attempt.max}`);
  }
  return parts.join(SOFT_SEP);
}

/**
 * How many rows the block occupies at a width. The chrome budgets from this without knowing the
 * rest of the run's state, so the block never paints over the body it was measured around.
 */
export function buildProgressRowCount(width: number): number {
  return width >= 120 ? 2 : 3;
}

/**
 * The same facts at every width, regrouped rather than dropped. Where the activity and freshness
 * share a row, the activity gives way: a long command is cut, never the clock that follows it.
 */
export function buildProgressLines(progress: BuildProgress, width: number): string[] {
  const counts = countsText(progress);
  if (buildProgressRowCount(width) === 2) {
    return [counts, fitBeforeTail(progress.activity, `${SOFT_SEP}${progress.freshness}`, width)];
  }
  return [counts, progress.activity, progress.freshness];
}

/**
 * A line whose head gives way to its tail: the head is cut from its end so the tail — a clock —
 * always fits. A command's label leads its head, so a long command loses only its own last words.
 */
export function fitBeforeTail(head: string, tail: string, width: number): string {
  const room = Math.max(1, width - getTerminalCellWidth(tail));
  return `${truncateTerminalDisplayText(head, room)}${tail}`;
}

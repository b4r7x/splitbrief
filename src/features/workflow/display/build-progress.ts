import { isImplementerPhase } from '../../../core/phases.js';
import { isApiProviderId } from '../../../core/providers/api-provider-catalog.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { formatElapsedClock, formatTime } from '../../../utils/format-time.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type {
  ActiveOperation,
  OpenTool,
  OperationsState,
} from '../../../stores/workflow/operations/state.js';
import { selectTaskListView, type TasksState } from '../../../stores/workflow/tasks.js';
import { suiteStatusText, reviewActivityText } from './phase-verb.js';
import { stallRunnerHint } from './live-activity.js';
import { runnerActivityLedgerItem } from './runner-activity-display.js';
import { buildProgressRowCount } from '../layout/chrome-rows.js';

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
   * The proof of life: how long the command in `activity` has run, else the silence warning —
   * `No output for <clock>`, then the open tool or the stream hint — else how long ago a seat
   * last said something.
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
  const command = runningCommand(input.operations, input.lifecycle.phase);
  if (command !== null) return command.label;
  const operation = input.operations.active;
  if (input.lifecycle.phase === 'final-review') {
    return reviewActivityText(
      operation,
      operation === null
        ? null
        : (runnerLabel(operation.backendKind, operation.runnerName) ?? null),
    );
  }
  if (operation === null) {
    return input.lifecycle.phase === 'escalating' ? 'Consulting the planner' : 'Between calls';
  }
  const task = operation.taskId === undefined ? '' : ` on ${operation.taskId}`;
  let doing: string;
  switch (operation.role) {
    case 'summary':
    case 'compaction':
      doing = operation.role;
      break;
    case 'implementer':
      doing = `working${task}`;
      break;
    case 'review':
      doing = 'reviewing';
      break;
    case 'planner':
    case 'escalation':
      doing = `answering the consult${task}`;
      break;
    default:
      return assertNever(operation.role);
  }
  return [runnerLabel(operation.backendKind, operation.runnerName), doing]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(SOFT_SEP);
}

/**
 * The command the run is inside: a reviewer check, its re-run at the run base, or an older
 * session's gate stage. No seat speaks while it runs, so its own clock is the block's proof of
 * life, and the age of a seat's last word would only contradict it.
 */
function runningCommand(
  operations: OperationsState,
  phase: LifecycleState['phase'],
): { label: string; startedTs: number } | null {
  const suite = operations.suiteStage ?? null;
  if (suite !== null)
    return { label: suiteStatusText(phase, suite), startedTs: suite.stageStartedTs };
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

/**
 * What the seat is doing through a silence, after the silence clock: the tool the stream opened
 * and has not closed, else the hint for a stream that reports a tool only once it ends. `null`
 * when the stream says nothing more than the silence itself.
 */
export function silenceTail(
  call: ActiveOperation | null,
  stall: LifecycleState['stall'],
): string | null {
  const tool = call?.openTools?.at(-1);
  if (tool !== undefined) return openToolText(tool);
  // The call in flight names its runner; the stall's own name stands in between calls.
  if (call?.runnerName !== undefined) {
    return stallRunnerHint(runnerTool(call.runnerName), call.backendKind);
  }
  if (stall === null || stall.runnerName === null) return null;
  return stallRunnerHint(runnerTool(stall.runnerName), stall.backendKind);
}

/** The silence warning the block and the byline share: `No output for 12:30`, then its tail. */
export function silenceText(silentMs: number, tail: string | null): string {
  const head = `No output for ${formatElapsedClock(silentMs)}`;
  return tail === null ? head : `${head}${SOFT_SEP}${tail}`;
}

// Silence is a seat's. While a command runs, its clock is the freshness. With no call running — the
// step between two calls — no one is expected to speak, and the quiet is only how long ago the last
// word was. The seat's name is already on the activity line beside this one, so the silence names
// only what the seat is doing through it. The clock runs on: the watchdog warns and never ends the
// call, so the line states no stop time.
function freshnessOf(input: DeriveBuildProgressInput): Pick<BuildProgress, 'freshness' | 'silent'> {
  const command = runningCommand(input.operations, input.lifecycle.phase);
  if (command !== null) {
    return {
      freshness: `running ${formatElapsedClock(input.now - command.startedTs)}`,
      silent: false,
    };
  }
  const call = input.operations.active;
  const silentMs = call === null ? null : runnerSilenceMs(input.lifecycle, input.now);
  if (silentMs !== null && silentMs >= UI_IDLE_WARN_MS) {
    return {
      freshness: silenceText(silentMs, silenceTail(call, input.lifecycle.stall)),
      silent: true,
    };
  }
  const lastTs = input.lifecycle.lastRunnerEventTs ?? null;
  if (lastTs === null) {
    return {
      freshness: input.lifecycle.phase === 'final-review' ? '' : 'no update yet',
      silent: false,
    };
  }
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
 * The same facts at every width, regrouped rather than dropped. Where the activity and freshness
 * share a row, the activity gives way: a long command is cut, never the clock that follows it. A
 * silence leads with its clock and ends with the tool it names, so that row is cut from its end.
 */
export function buildProgressLines(progress: BuildProgress, width: number): string[] {
  const counts = countsText(progress);
  if (buildProgressRowCount(width) === 2) {
    const tail = progress.freshness.length > 0 ? `${SOFT_SEP}${progress.freshness}` : '';
    return [
      counts,
      progress.silent
        ? truncateTerminalDisplayText(`${progress.activity}${tail}`, width)
        : fitBeforeTail(progress.activity, tail, width),
    ];
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

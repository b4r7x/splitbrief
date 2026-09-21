import type { Config } from '../../../core/schemas/config.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { formatTime } from '../../../utils/format-time.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type { OperationRole, OperationsState } from '../../../stores/workflow/operations/state.js';
import { selectTaskListView, type TasksState } from '../../../stores/workflow/tasks.js';
import { inlineActiveVerb } from './phase-verb.js';

/** How long a seat may say nothing before the block stops reporting freshness and reports silence. */
export const UI_IDLE_WARN_MS = 60_000;

export type BuildProgressEta =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'estimate'; remainingMs: number };

export interface BuildProgress {
  passed: number;
  total: number;
  escalated: number;
  failed: number;
  attempt: { current: number; max: number };
  eta: BuildProgressEta;
  /** What the run is doing: the seat and its operation, or the gate command it is inside. */
  activity: string;
  /** How long ago it last said so. */
  freshness: string;
}

export interface DeriveBuildProgressInput {
  tasks: TasksState;
  lifecycle: LifecycleState;
  operations: OperationsState;
  config: Config | null;
  now: number;
}

function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

// Calls the run makes beside the seat's own work; the phase names the seat's work, never theirs.
const SIDE_CALL_ROLES: ReadonlySet<OperationRole> = new Set<OperationRole>([
  'summary',
  'compaction',
]);

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
    active.runnerName !== last.runnerName
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
    const command = stage.command ?? stage.stage;
    const silentMs = input.now - (input.lifecycle.lastRunnerEventTs ?? stage.stageStartedTs);
    return [
      command,
      `running ${formatTime(input.now - stage.stageStartedTs)}`,
      `no output for ${seconds(silentMs)}s`,
    ].join(SOFT_SEP);
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
  return [operation.runnerName ?? input.lifecycle.phase, doing]
    .filter((part) => part !== '')
    .join(SOFT_SEP);
}

function freshnessLine(input: DeriveBuildProgressInput): string {
  const lastTs = input.lifecycle.lastRunnerEventTs ?? null;
  if (lastTs === null) return 'no update yet';
  const silentMs = input.now - lastTs;
  if (silentMs >= UI_IDLE_WARN_MS) {
    const tool = input.operations.active?.runnerName ?? 'the worker';
    return `No update from ${tool} for ${seconds(silentMs)}s`;
  }
  return `last event ${seconds(silentMs)}s ago`;
}

export function deriveBuildProgress(input: DeriveBuildProgressInput): BuildProgress {
  const view = selectTaskListView(input.tasks);
  return {
    passed: view.passed,
    total: view.total,
    escalated: view.escalated,
    failed: view.failed,
    attempt: {
      current: input.tasks.currentAttempt,
      max: 1 + (input.config?.workflow.maxRetries ?? 0),
    },
    eta: etaFor(input, view.total - view.finished - view.failed),
    activity: activityLine(input),
    freshness: freshnessLine(input),
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

/**
 * How many rows the block occupies at a width. The chrome budgets from this without knowing the
 * run's state, so the block never paints over the body it was measured around.
 */
export function buildProgressRowCount(width: number): number {
  if (width >= 120) return 2;
  if (width >= 80) return 4;
  return 5;
}

/** The same five facts at every width, regrouped rather than dropped. */
export function buildProgressLines(progress: BuildProgress, width: number): string[] {
  const counts = countsText(progress);
  const attempt = `attempt ${progress.attempt.current} of ${progress.attempt.max}`;
  const eta = etaText(progress.eta);
  switch (buildProgressRowCount(width)) {
    case 2:
      return [
        [counts, attempt, eta].join(SOFT_SEP),
        [progress.activity, progress.freshness].join(SOFT_SEP),
      ];
    case 4:
      return [counts, [attempt, eta].join(SOFT_SEP), progress.activity, progress.freshness];
    default:
      return [counts, attempt, eta, progress.activity, progress.freshness];
  }
}

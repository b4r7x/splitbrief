import { CREW_SEAT_LABELS, cutSeatIdentity, type CrewSeatId } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { isImplementerPhase } from '../../../core/phases.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import { SOFT_SEP } from '../../../core/separators.js';
import {
  getTerminalCellWidth,
  stripTerminalControls,
  truncateTerminalDisplayText,
  segmentsForRowText,
} from '../../../utils/display-text.js';
import { formatElapsedClock, formatTime } from '../../../utils/format-time.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type {
  ActiveOperation,
  OpenTool,
  OperationsState,
} from '../../../stores/workflow/operations/state.js';
import { selectTaskListView, type TasksState } from '../../../stores/workflow/tasks.js';
import { suiteStatusParts, reviewActivityParts, reviewActivitySpans } from './phase-verb.js';
import { formatRecordedSeatIdentity } from './recorded-seat-identity.js';
import { stallRunnerHint } from './live-activity.js';
import { runnerActivityLedgerItem, runnerActivityModelRole } from './runner-activity-display.js';
import { buildProgressRowCount } from '../layout/chrome-rows.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { separatedSpans } from '../conversation-rows/row-format/text.js';

/**
 * The floor under the silence warning: the block never paints it for a seat quieter than this,
 * however early a runner is configured to warn. The watchdog's own warn decides when a stall
 * stands.
 */
export const UI_IDLE_WARN_MS = 60_000;

type BuildProgressSpan = Readonly<Pick<ConversationRowSegment, 'text' | 'tone'>>;

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
  activitySpans: readonly BuildProgressSpan[];
  activityIdentity: {
    prefix: readonly BuildProgressSpan[];
    identity: BuildProgressSpan;
    suffix: readonly BuildProgressSpan[];
  } | null;
  /**
   * The proof of life: how long the command in `activity` has run, else the silence warning —
   * `No output for <clock>`, then the open tool or the stream hint — else how long ago a seat
   * last said something.
   */
  freshness: string;
  freshnessSpans: readonly BuildProgressSpan[];
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

// What the run is doing, not what it has spent: usage is reported where a reader asks for it,
// through `/usage`, and never as a rounded count that reads `0k` until the first report lands.
function activityLine(
  input: DeriveBuildProgressInput,
): Pick<BuildProgress, 'activity' | 'activitySpans' | 'activityIdentity'> {
  const command = runningCommand(input.operations, input.lifecycle.phase);
  if (command !== null) return activityResult(command.spans);
  const operation = input.operations.active;
  const identity =
    operation === null
      ? null
      : formatRecordedSeatIdentity({ ...operation, role: runnerActivityModelRole(operation.role) });
  const reviewing =
    input.lifecycle.phase === 'final-review' ||
    (operation?.role === 'review' && operation.taskId === undefined);
  if (reviewing) {
    const parts = reviewActivityParts(operation, identity);
    return activityResult(
      reviewActivitySpans(parts),
      parts.identity === null ? null : { ...parts, identity: parts.identity },
    );
  }
  if (operation === null) {
    return activityResult([
      {
        text:
          input.lifecycle.phase === 'escalating'
            ? 'Waiting for the consult answer'
            : 'Between calls',
        tone: 'textDim',
      },
    ]);
  }
  const task = operation.taskId === undefined ? '' : ` on ${operation.taskId}`;
  let seat: CrewSeatId | undefined;
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
      seat = 'review';
      doing = `answering the consult${task}`;
      break;
    case 'planner':
    case 'escalation':
      seat = 'plan';
      doing = `answering the consult${task}`;
      break;
    default:
      return assertNever(operation.role);
  }
  const prefix: BuildProgressSpan[] =
    seat === undefined
      ? []
      : [
          { text: CREW_SEAT_LABELS[seat], tone: CREW_SEAT_ROLES[seat] },
          { text: SOFT_SEP, tone: 'textDim' },
        ];
  if (identity === null) return activityResult([...prefix, { text: doing, tone: 'textDim' }]);
  const identitySpan: BuildProgressSpan = {
    text: identity,
    tone: runnerActivityModelRole(operation.role),
  };
  const suffix: BuildProgressSpan[] = [
    { text: SOFT_SEP, tone: 'textDim' },
    { text: doing, tone: 'textDim' },
  ];
  return activityResult([...prefix, identitySpan, ...suffix], {
    prefix,
    identity: identitySpan,
    suffix,
  });
}

function activityResult(
  spans: readonly BuildProgressSpan[],
  activityIdentity: BuildProgress['activityIdentity'] = null,
): Pick<BuildProgress, 'activity' | 'activitySpans' | 'activityIdentity'> {
  return { activity: spansText(spans), activitySpans: spans, activityIdentity };
}

/**
 * The command the run is inside: a reviewer check, its re-run at the run base, or an older
 * session's gate stage. No seat speaks while it runs, so its own clock is the block's proof of
 * life, and the age of a seat's last word would only contradict it.
 */
function runningCommand(
  operations: OperationsState,
  phase: LifecycleState['phase'],
): { spans: readonly BuildProgressSpan[]; startedTs: number } | null {
  const suite = operations.suiteStage ?? null;
  if (suite !== null)
    return {
      spans: suiteStatusParts(phase, suite, operations.active),
      startedTs: suite.stageStartedTs,
    };
  const stage = operations.validationStage ?? null;
  if (stage === null) return null;
  return {
    spans: [{ text: stage.command ?? stage.stage, tone: 'textDim' }],
    startedTs: stage.stageStartedTs,
  };
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
function freshnessResult(
  spans: readonly BuildProgressSpan[],
  silent: boolean,
): Pick<BuildProgress, 'freshness' | 'freshnessSpans' | 'silent'> {
  return { freshness: spansText(spans), freshnessSpans: spans, silent };
}

function freshnessOf(
  input: DeriveBuildProgressInput,
): Pick<BuildProgress, 'freshness' | 'freshnessSpans' | 'silent'> {
  const command = runningCommand(input.operations, input.lifecycle.phase);
  if (command !== null) {
    return freshnessResult(
      [
        { text: 'running', tone: stateTone('running') },
        { text: ` ${formatElapsedClock(input.now - command.startedTs)}`, tone: 'textDim' },
      ],
      false,
    );
  }
  const call = input.operations.active;
  const silentMs = call === null ? null : runnerSilenceMs(input.lifecycle, input.now);
  if (silentMs !== null && silentMs >= UI_IDLE_WARN_MS) {
    return freshnessResult(
      separatedSpans(
        silenceText(silentMs, silenceTail(call, input.lifecycle.stall)),
        stateTone('attention'),
      ),
      true,
    );
  }
  const lastTs = input.lifecycle.lastRunnerEventTs ?? null;
  if (lastTs === null) {
    return freshnessResult(
      [{ text: input.lifecycle.phase === 'final-review' ? '' : 'no update yet', tone: 'textDim' }],
      false,
    );
  }
  return freshnessResult(
    [{ text: `last event ${formatTime(input.now - lastTs)} ago`, tone: 'textDim' }],
    false,
  );
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
    ...activityLine(input),
    ...freshnessOf(input),
  };
}

export function passedCountSpans(count: string) {
  return [
    { text: `${count} `, tone: 'textDim' },
    { text: 'passed', tone: stateTone('passed') },
  ] satisfies BuildProgressSpan[];
}

export function passedFractionSpans(count: string) {
  return [{ text: `${count} passed`, tone: 'textDim' }] satisfies BuildProgressSpan[];
}

export function taskOutcomeCountsSpans(
  head: readonly BuildProgressSpan[],
  progress: Pick<BuildProgress, 'escalated' | 'failed'>,
): BuildProgressSpan[] {
  const parts: BuildProgressSpan[] = [...head];
  if (progress.escalated > 0)
    parts.push(
      { text: `${SOFT_SEP}${progress.escalated} `, tone: 'textDim' },
      { text: 'escalated', tone: stateTone('attention') },
    );
  if (progress.failed > 0)
    parts.push(
      { text: `${SOFT_SEP}${progress.failed} `, tone: 'textDim' },
      { text: 'failed', tone: stateTone('failed') },
    );
  return parts;
}

function countsSpans(progress: BuildProgress): BuildProgressSpan[] {
  const parts = taskOutcomeCountsSpans(
    passedFractionSpans(`${progress.passed}/${progress.total} briefs`),
    progress,
  );
  if (progress.attempt !== null) {
    parts.push(
      { text: SOFT_SEP, tone: 'textDim' },
      {
        text: `attempt ${progress.attempt.current} of ${progress.attempt.max}`,
        tone: 'textDim',
      },
    );
  }
  return parts;
}

/**
 * The same facts at every width, regrouped rather than dropped. Where the activity and freshness
 * share a row, the activity gives way: a long command is cut, never the clock that follows it. A
 * silence first loses its trailing description, cut from the end, then whole identity segments.
 * The seat label, tool word, work and silence clock stay.
 */
export function buildProgressRows(
  progress: BuildProgress,
  width: number,
): {
  key: string;
  text: string;
  spans: readonly BuildProgressSpan[];
}[] {
  const counts = progressRow('counts', countsSpans(progress), width);
  if (buildProgressRowCount(width) === 2) {
    const freshness = progress.silent
      ? fitSilenceTail(
          progress.freshness,
          width - getTerminalCellWidth(progress.activity + SOFT_SEP),
        )
      : progress.freshness;
    const tail: BuildProgressSpan[] =
      freshness.length > 0
        ? [
            { text: SOFT_SEP, tone: 'textDim' },
            ...segmentsForRowText(progress.freshnessSpans, freshness),
          ]
        : [];
    const activity = fitActivity(
      progress,
      Math.max(0, width - getTerminalCellWidth(spansText(tail))),
    );
    return [counts, progressRow('activity', [...activity, ...tail], width)];
  }
  return [
    counts,
    progressRow('activity', fitActivity(progress, width), width),
    progressRow(
      'freshness',
      segmentsForRowText(
        progress.freshnessSpans,
        progress.silent ? fitSilenceTail(progress.freshness, width) : progress.freshness,
      ),
      width,
    ),
  ];
}

function progressRow(key: string, spans: readonly BuildProgressSpan[], width: number) {
  const fitted = fitProgressSpans(spans, width);
  return { key, text: spansText(fitted), spans: fitted };
}

function spansText(spans: readonly BuildProgressSpan[]): string {
  return spans.map((span) => span.text).join('');
}

function fitProgressSpans(
  spans: readonly BuildProgressSpan[],
  width: number,
): readonly BuildProgressSpan[] {
  const clean = spans.map((span) => ({ ...span, text: stripTerminalControls(span.text) }));
  const text = spansText(clean);
  const fitted = truncateTerminalDisplayText(text, width);
  return segmentsForRowText(clean, fitted);
}

function fitSilenceTail(freshness: string, width: number): string {
  const clockEnd = freshness.indexOf(SOFT_SEP);
  const clock = clockEnd === -1 ? freshness : freshness.slice(0, clockEnd);
  return width <= getTerminalCellWidth(clock + SOFT_SEP)
    ? clock
    : truncateTerminalDisplayText(freshness, width);
}

function fitActivity(progress: BuildProgress, width: number): readonly BuildProgressSpan[] {
  const parts = progress.activityIdentity;
  if (parts === null) return fitProgressSpans(progress.activitySpans, width);
  const budget = Math.max(
    0,
    width - getTerminalCellWidth(spansText([...parts.prefix, ...parts.suffix])),
  );
  const identity = { ...parts.identity, text: cutSeatIdentity(parts.identity.text, budget) };
  const suffix = identity.text === '' ? parts.suffix.slice(1) : parts.suffix;
  const spans = [...parts.prefix, identity, ...suffix];
  return segmentsForRowText(spans, spansText(spans).trimEnd());
}

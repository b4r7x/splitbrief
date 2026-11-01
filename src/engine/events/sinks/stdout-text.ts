import { baseSplit, baseSplitNames } from '../../../core/review/base-split.js';
import { fixCheckVerdict } from '../../../core/review/fix-task.js';
import { stuckAnswerWords } from '../../../core/review/stuck.js';
import { setAsideLine } from '../../../core/review/verdict.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import { EMPTY_RUN_VIEW, reduceRunView, type RunView } from '../../../core/run-view/reduce.js';
import { seatWaitParts } from '../../../core/sessions/seat-wait-line.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { checksSummary } from '../../../core/validation/checks-summary.js';
import { reusedNote } from '../../../core/validation/reused-note.js';
import { oneLineDisplayText, stripTerminalControls } from '../../../utils/display-text.js';
import { formatDuration, formatElapsedClock } from '../../../utils/format-time.js';
import { boundEngineEventForConsumer } from '../bound.js';
import type { EngineEvent, EventSink } from '../types.js';

export interface StdoutTextSinkOptions {
  output?: NodeJS.WritableStream | undefined;
}

function reviewChecksLine(event: Extract<EngineEvent, { type: 'review_checks' }>): string {
  return event.status === 'off'
    ? 'reviewer checks: off'
    : 'reviewer checks: none (the plan names no project gate)';
}

/**
 * The watchdog's warn: the call runs on, so the line states the silence and no outcome. A CLI call
 * names its tool by id (`claude` runs as `claude-code`); a call with no runner name names its role.
 */
function stalledLine(event: Extract<EngineEvent, { type: 'runner_call_stalled' }>): string {
  const name = event.runnerName;
  const tool =
    name === undefined
      ? ''
      : ` (${event.backendKind === 'cli' ? (cliToolIdForCommand(name) ?? name) : name})`;
  return `stalled: ${event.role}${tool}${SOFT_SEP}no output for ${formatElapsedClock(event.silentMs)}`;
}

/** The failing tests a split names, one line per side, under its verdict line. */
function splitNameLines(event: Extract<EngineEvent, { type: 'full_suite' }>): string[] {
  if (event.id === undefined) return [];
  const label = event.moment === 'base' ? 'base re-run' : 'reviewer check';
  return baseSplitNames(event).map(
    ({ side, names }) => `${label} ${event.id} ${side}: ${names.join(SOFT_SEP)}`,
  );
}

function reviewCheckLine(event: Extract<EngineEvent, { type: 'full_suite' }>): string | null {
  // A `full_suite` without an id is a full-suite stage of a session from before the reviewer chose its checks.
  if (event.id === undefined || event.status === 'running' || event.status === 'stopped')
    return null;
  const reused = event.reusedAt === undefined ? '' : `${SOFT_SEP}${reusedNote(event.reusedAt)}`;
  // The split of a red reviewer or verify check; an older run carried it on its base re-run.
  const split =
    (event.moment === 'pre-review' || event.moment === 'base' || event.moment === 'verify') &&
    event.passed === false &&
    event.newFailures !== undefined &&
    event.preExisting !== undefined
      ? baseSplit({
          newFailures: event.newFailures,
          preExisting: event.preExisting,
          notVerified: event.notVerified,
          reason: event.detail,
        })
      : null;
  const why = split === null || split.why === null ? '' : `${SOFT_SEP}${split.why}`;
  if (event.moment === 'plan' || event.moment === 'verify') {
    const label =
      event.scenario !== undefined
        ? `Render ${event.scenario}`
        : event.moment === 'plan'
          ? `plan check ${event.id}`
          : `verify ${event.id}`;
    const detail = event.detail === undefined ? '' : ` (${event.detail})`;
    if (event.status === 'refused') return `${label}: refused${detail}`;
    if (event.status === 'not-run') return `${label}: not run${detail}`;
    const verdict =
      split?.verdict ??
      (event.passed === true ? (event.scenario === undefined ? 'passed' : 'rendered') : 'failed');
    const clock =
      event.reusedAt !== undefined
        ? reused
        : event.duration === undefined
          ? ''
          : `${SOFT_SEP}${formatDuration(event.duration)}`;
    const command =
      event.scenario !== undefined ? '' : event.command === '' ? detail : ` (${event.command})`;
    return `${label}: ${verdict}${clock}${why}${command}`;
  }
  const label =
    event.moment === 'base'
      ? 'base re-run'
      : event.moment === 'brief'
        ? 'fix check'
        : 'reviewer check';
  const detail = event.detail ?? 'no detail given';
  if (event.status === 'refused') return `${label} ${event.id}: refused (${detail})`;
  if (event.status === 'not-run') return `${label} ${event.id}: not run (${detail})`;
  if (
    event.moment === 'brief' &&
    event.own !== undefined &&
    event.ownLeft !== undefined &&
    event.others !== undefined
  ) {
    const verdict = fixCheckVerdict({
      own: event.own,
      ownLeft: event.ownLeft,
      deferred: event.deferred ?? 0,
      deferredTo: event.deferredTo ?? [],
      others: event.others,
    }).join(SOFT_SEP);
    return `${label} ${event.id}: ${verdict}${reused} (${event.command})`;
  }
  if (split !== null) {
    const command = event.moment === 'base' ? '' : ` (${event.command})`;
    return `${label} ${event.id}: ${split.verdict}${reused}${why}${command}`;
  }
  if (event.moment === 'base')
    return `${label} ${event.id}: ${event.passed === true ? 'passes' : 'fails'}${reused}`;
  return `${label} ${event.id}: ${event.passed === true ? 'passed' : 'failed'}${reused} (${event.command})`;
}

function briefChecks(view: RunView, taskId: string): string {
  return checksSummary(view.briefs.checks.get(taskId) ?? []);
}

/**
 * The `--plain` projection: a few line shapes and nothing else, so a script can
 * read a run with `grep` and a human can read it without a JSON parser. The
 * `checks` of a task line are its brief checks; reviewer checks that are off or
 * that the plan does not name get a `reviewer checks` line, and a reviewer check
 * that is refused or not run gets its own `reviewer check` line, so no check
 * is silent.
 *
 *   phase: implementing
 *   task T001: done (2 of 2 checks passed)
 *   reviewer checks: off | reviewer checks: none (the plan names no project gate)
 *   reviewer check V1: passed (<command>) | failed (<command>)
 *   reviewer check V1: <M> new, <N> pre-existing (<command>)
 *   reviewer check V1: [<M> new, <N> pre-existing, ]<K> not verified at the run base · <reason> (<command>)
 *   reviewer check V1: pre-existing · all <N> failures also fail before this run's changes (<command>)
 *   reviewer check V1: pre-existing · the failure also fails before this run's changes (<command>)
 *   reviewer check V1 new: <test>[ · <test> …][ · +<N> more]
 *   reviewer check V1 pre-existing: <test>[ · <test> …][ · +<N> more]
 *   reviewer check V1: refused (<detail>) | not run (<detail>)
 *   base re-run V1: passes | fails
 *   base re-run V1: refused (<detail>) | not run (<detail>)
 *   fix check V1: passed (<command>) | failed (<command>)
 *   fix check V1: your <N> failures gone · <M> others left for their fix tasks or the next review (<command>)
 *   fix check V1: <J> of your <N> failures gone · <D> left to T025 (<command>)
 *   fix check V1: <K> of your <N> failures remain (<command>)
 *   fix check V1: no failure of yours · <M> others left for their fix tasks or the next review (<command>)
 *   fix check V1: refused (<detail>) | not run (<detail>)
 *   plan check K1: passed · 14.2s (<command>) | failed · 14.2s (<command>)
 *   plan check K1: refused (<detail>) | not run (<detail>)
 *   verify K1: passed · 14.2s (<command>) | failed · 14.2s (<command>)
 *   verify K1: refused (<detail>) | not run (<detail>)
 *   reviewer check V1: passed · reused, ran 11:53 (<command>)   (and on every check verdict above)
 *   Render workflow-x: rendered · 14.2s | failed · 14.2s
 *   Render workflow-x: refused (<detail>) | not run (<detail>)
 *   stalled: implementer (opencode) · no output for 5:00
 *   review: passed | failed [(<n> blocking)] | no verdict | stopped
 *   review: Set aside V6.1: <reason>
 *   review: stuck after T004 · planner: new fix brief T006 · <diagnosis>
 *   task review T002: failed (1 blocking) | task review: no verdict
 *   done: 3 tasks
 *
 * A `pass` and a `pass-with-notes` both read `passed`; `fail` carries its
 * blocking count when the completion records the finding counts.
 */
export function createStdoutTextSink(opts: StdoutTextSinkOptions = {}): EventSink {
  const output = opts.output ?? process.stdout;
  let view = EMPTY_RUN_VIEW;

  function write(line: string): void {
    // A consumer's stdout pipe is a projection boundary: a closed pipe never
    // becomes an authority result for the workflow.
    try {
      output.write(`${line}\n`);
    } catch {
      // Intentionally inert.
    }
  }

  return (event) => {
    const bounded = boundEngineEventForConsumer(event, 'stdout-text');
    const previous = view;
    view = reduceRunView(view, bounded);
    if (view.phase !== previous.phase) write(`phase: ${view.phase}`);
    switch (bounded.type) {
      case 'user_message':
        if (bounded.attachedInputs !== undefined && bounded.attachedInputs.length > 0)
          write(
            `attached files: ${bounded.attachedInputs.map((input) => `${stripTerminalControls(input.path)} (${input.kind})`).join('; ')}`,
          );
        return;
      case 'seat_wait_started': {
        // A start the view did not take (no tool) writes nothing.
        const wait = view.seatWait === previous.seatWait ? null : view.seatWait;
        const parts = wait === null ? null : seatWaitParts(wait.tool, wait.wait.resetAt);
        if (wait !== null && parts !== null) write(`waiting: ${wait.tool}${SOFT_SEP}${parts[1]}`);
        return;
      }
      case 'review_checks':
        write(reviewChecksLine(bounded));
        return;
      case 'full_suite': {
        const line = reviewCheckLine(bounded);
        if (line !== null) write(line);
        for (const names of splitNameLines(bounded)) write(names);
        return;
      }
      case 'runner_call_stalled':
        write(stalledLine(bounded));
        return;
      case 'task_completed':
        write(`task ${bounded.taskId}: done (${briefChecks(view, bounded.taskId)})`);
        return;
      case 'task_full_fail':
        write(
          `task ${bounded.taskId}: failed (${bounded.reason ?? briefChecks(view, bounded.taskId)})`,
        );
        return;
      case 'task_skipped':
        write(`task ${bounded.taskId}: failed (skipped)`);
        return;
      case 'review_completed': {
        let words: string;
        switch (bounded.verdict) {
          case 'pass':
          case 'pass-with-notes':
            words = 'passed';
            break;
          case 'fail':
            words =
              bounded.findings === undefined
                ? 'failed'
                : `failed (${bounded.findings.blocking} blocking)`;
            break;
          case 'no-verdict':
            words = 'no verdict';
            break;
          case 'stopped':
            words = 'stopped';
            break;
        }
        const scope =
          bounded.scope === 'task'
            ? `task review${bounded.afterTaskId === undefined ? '' : ` ${bounded.afterTaskId}`}: `
            : 'review: ';
        write(`${scope}${words}`);
        for (const entry of bounded.setAside ?? []) write(`${scope}${setAsideLine(entry)}`);
        return;
      }
      case 'consult_answered':
        if (bounded.reason === 'no-progress')
          write(
            `review: stuck after ${bounded.taskId}${SOFT_SEP}planner: ${stuckAnswerWords(bounded)}${SOFT_SEP}${oneLineDisplayText(bounded.diagnosis)}`,
          );
        return;
      case 'workflow_complete': {
        // The run's count from its state: a continue completes only the briefs it had left.
        write(`done: ${view.briefs.completedTasks ?? 0} tasks`);
        return;
      }
      default:
        return;
    }
  };
}

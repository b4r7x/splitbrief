import { baseSplit, baseSplitNames } from '../../../core/review/base-split.js';
import { fixCheckVerdict } from '../../../core/review/fix-task.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { checksSummary } from '../../../core/validation/checks-summary.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { formatDuration, formatElapsedClock } from '../../../utils/format-time.js';
import { boundEngineEventForConsumer } from '../bound.js';
import type { EngineEvent, EventSink } from '../types.js';

export interface StdoutTextSinkOptions {
  output?: NodeJS.WritableStream | undefined;
}

function reviewChecksLines(event: Extract<EngineEvent, { type: 'review_checks' }>): string[] {
  if (event.status === 'off') return ['reviewer checks: off'];
  if (event.status === 'skipped') {
    const ids = (event.commands ?? []).map((command) => command.id).join(', ');
    return [`reviewer checks: not run ${ids} (${event.reason ?? 'no reason given'})`];
  }
  const lines =
    (event.commands ?? []).length === 0
      ? [`reviewer checks: none (${event.reason ?? 'no reason given'})`]
      : [];
  for (const entry of event.declined ?? []) {
    lines.push(`reviewer check declined: ${entry.target} (${entry.reason})`);
  }
  return lines;
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

/** The failing tests a base re-run names, one line per side, under its verdict line. */
function baseNameLines(event: Extract<EngineEvent, { type: 'full_suite' }>): string[] {
  if (event.id === undefined) return [];
  return baseSplitNames(event).map(
    ({ side, names }) => `base re-run ${event.id} ${side}: ${names.join(SOFT_SEP)}`,
  );
}

function reviewCheckLine(event: Extract<EngineEvent, { type: 'full_suite' }>): string | null {
  // A `full_suite` without an id is a full-suite stage of a session from before the reviewer chose its checks.
  if (event.id === undefined || event.status === 'running' || event.status === 'stopped')
    return null;
  if (event.moment === 'plan') {
    const label =
      event.scenario === undefined ? `plan check ${event.id}` : `Render ${event.scenario}`;
    const detail = event.detail === undefined ? '' : ` (${event.detail})`;
    if (event.status === 'refused') return `${label}: refused${detail}`;
    if (event.status === 'not-run') return `${label}: not run${detail}`;
    const verdict =
      event.passed === true ? (event.scenario === undefined ? 'passed' : 'rendered') : 'failed';
    const duration =
      event.duration === undefined ? '' : `${SOFT_SEP}${formatDuration(event.duration)}`;
    const command = event.scenario === undefined ? ` (${event.command})` : '';
    return `${label}: ${verdict}${duration}${command}`;
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
      others: event.others,
      proven: event.proven ?? true,
    }).join(SOFT_SEP);
    return `${label} ${event.id}: ${verdict} (${event.command})`;
  }
  if (event.moment === 'base') {
    if (
      event.passed === false &&
      event.newFailures !== undefined &&
      event.preExisting !== undefined
    ) {
      const split = baseSplit({
        newFailures: event.newFailures,
        preExisting: event.preExisting,
        notVerified: event.notVerified,
        reason: event.detail,
      });
      const why = split.why === null ? '' : `${SOFT_SEP}${split.why}`;
      return `${label} ${event.id}: ${split.verdict}${why}`;
    }
    return `${label} ${event.id}: ${event.passed === true ? 'passes' : 'fails'}`;
  }
  return event.passed === true
    ? `${label} ${event.id}: passed (${event.command})`
    : `${label} ${event.id}: failed (${event.command})`;
}

/**
 * The `--plain` projection: a few line shapes and nothing else, so a script can
 * read a run with `grep` and a human can read it without a JSON parser. The
 * `checks` of a task line are its brief checks; a reviewer check that is off,
 * declined, refused or not run gets its own `reviewer check` line, so no check
 * is silent.
 *
 *   phase: implementing
 *   task T001: done (2 of 2 checks passed)
 *   reviewer checks: off | reviewer checks: none (<reason>)
 *   reviewer check declined: <target> (<reason>)
 *   reviewer check V1: passed (<command>) | failed (<command>)
 *   reviewer check V1: refused (<detail>) | not run (<detail>)
 *   base re-run V1: passes | fails
 *   base re-run V1: <M> new, <N> pre-existing
 *   base re-run V1: [<M> new, <N> pre-existing, ]<K> not verified at the run base · <reason>
 *   base re-run V1: pre-existing · all <N> failures also fail before this run's changes
 *   base re-run V1: pre-existing · the failure also fails before this run's changes
 *   base re-run V1 new: <test>[ · <test> …][ · +<N> more]
 *   base re-run V1 pre-existing: <test>[ · <test> …][ · +<N> more]
 *   base re-run V1: refused (<detail>) | not run (<detail>)
 *   fix check V1: passed (<command>) | failed (<command>)
 *   fix check V1: your <N> failures gone · <M> others left (<command>)
 *   fix check V1: <K> of your <N> failures remain (<command>)
 *   fix check V1: your <N> failures not shown · not proven fixed (<command>)
 *   fix check V1: refused (<detail>) | not run (<detail>)
 *   stalled: implementer (opencode) · no output for 5:00
 *   review: passed
 *   done: 3 tasks
 */
export function createStdoutTextSink(opts: StdoutTextSinkOptions = {}): EventSink {
  const output = opts.output ?? process.stdout;
  const checks = new Map<string, string>();
  let lastPhase: string | null = null;

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
    const phase = 'phase' in bounded && typeof bounded.phase === 'string' ? bounded.phase : null;
    // `idle` is the state a run sits in before it enters its first phase: a
    // pre-start warning or an init error carries it, and the contract lists
    // only phases the run actually enters.
    if (phase !== null && phase !== 'idle' && phase !== lastPhase) {
      lastPhase = phase;
      write(`phase: ${phase}`);
    }

    switch (bounded.type) {
      case 'user_message':
        if (bounded.attachedInputs !== undefined && bounded.attachedInputs.length > 0)
          write(
            `attached files: ${bounded.attachedInputs.map((input) => `${stripTerminalControls(input.path)} (${input.kind})`).join('; ')}`,
          );
        return;
      case 'checks_run':
        checks.set(bounded.taskId, checksSummary(bounded.results));
        return;
      case 'review_checks':
        for (const line of reviewChecksLines(bounded)) write(line);
        return;
      case 'full_suite': {
        const line = reviewCheckLine(bounded);
        if (line !== null) write(line);
        for (const names of baseNameLines(bounded)) write(names);
        return;
      }
      case 'runner_call_stalled':
        write(stalledLine(bounded));
        return;
      case 'task_completed':
        write(`task ${bounded.taskId}: done (${checks.get(bounded.taskId) ?? 'no checks'})`);
        return;
      case 'task_full_fail':
        write(
          `task ${bounded.taskId}: failed (${bounded.reason ?? checks.get(bounded.taskId) ?? 'no checks'})`,
        );
        return;
      case 'task_skipped':
        write(`task ${bounded.taskId}: failed (skipped)`);
        return;
      case 'review_completed': {
        const scope =
          bounded.scope === 'task'
            ? `task${bounded.afterTaskId === undefined ? '' : ` ${bounded.afterTaskId}`}`
            : 'final';
        write(
          bounded.findings === undefined
            ? `review: ${scope} ${bounded.verdict}`
            : `review: ${scope} ${bounded.verdict} (${bounded.findings.blocking} blocking)`,
        );
        return;
      }
      case 'workflow_complete': {
        // The run's count from its state: a continue completes only the briefs it had left.
        write(`done: ${bounded.completedTasks ?? 0} tasks`);
        return;
      }
      default:
        return;
    }
  };
}

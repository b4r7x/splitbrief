import { boundEngineEventForConsumer } from '../bound.js';
import type { EngineEvent, EventSink } from '../types.js';

export interface StdoutTextSinkOptions {
  output?: NodeJS.WritableStream | undefined;
}

function checksSummary(event: Extract<EngineEvent, { type: 'checks_run' }>): string {
  if (event.results.length === 0) return 'no checks';
  const passed = event.results.filter((result) => result.passed).length;
  return `${passed} of ${event.results.length} checks passed`;
}

function reviewChecksLines(event: Extract<EngineEvent, { type: 'review_checks' }>): string[] {
  if (event.status === 'off') return ['reviewer checks: off'];
  const lines =
    (event.commands ?? []).length === 0
      ? [`reviewer checks: none (${event.reason ?? 'no reason given'})`]
      : [];
  for (const entry of event.declined ?? []) {
    lines.push(`reviewer check declined: ${entry.target} (${entry.reason})`);
  }
  return lines;
}

function reviewCheckLine(event: Extract<EngineEvent, { type: 'full_suite' }>): string | null {
  // A `full_suite` without an id is a full-suite stage of a session from before the reviewer chose its checks.
  if (event.id === undefined || event.status === 'running') return null;
  const at = event.moment === 'base' ? ' at base' : '';
  const detail = event.detail ?? 'no detail given';
  if (event.status === 'refused') return `reviewer check ${event.id}${at}: refused (${detail})`;
  if (event.status === 'not-run') return `reviewer check ${event.id}${at}: not run (${detail})`;
  if (event.moment === 'base') {
    return `reviewer check ${event.id} at base: ${event.passed === true ? 'passes' : 'fails'}`;
  }
  return event.passed === true
    ? `reviewer check ${event.id}: passed (${event.command})`
    : `reviewer check ${event.id}: failed (${event.command})`;
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
 *   reviewer check V1 at base: passes | fails
 *   reviewer check V1 at base: refused (<detail>) | not run (<detail>)
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
      case 'checks_run':
        checks.set(bounded.taskId, checksSummary(bounded));
        return;
      case 'review_checks':
        for (const line of reviewChecksLines(bounded)) write(line);
        return;
      case 'full_suite': {
        const line = reviewCheckLine(bounded);
        if (line !== null) write(line);
        return;
      }
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
      case 'workflow_complete': {
        const verdict = bounded.review ?? 'passed';
        write(
          bounded.blocking === undefined
            ? `review: ${verdict}`
            : `review: ${verdict} (${bounded.blocking} blocking)`,
        );
        // The run's count from its state: a continue completes only the briefs it had left.
        write(`done: ${bounded.completedTasks ?? 0} tasks`);
        return;
      }
      default:
        return;
    }
  };
}

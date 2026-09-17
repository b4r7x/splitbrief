import { NO_GATES_WARNING } from '../../../core/pipeline-spec/gates.js';
import { VALIDATION_STAGES } from '../../../core/schemas/enums.js';
import { boundEngineEventForConsumer } from '../bound.js';
import type { EngineEvent, EventSink } from '../types.js';

export interface StdoutTextSinkOptions {
  output?: NodeJS.WritableStream | undefined;
}

function passedGates(event: Extract<EngineEvent, { type: 'validate' }>): string {
  const passed = VALIDATION_STAGES.filter((stage) => event.stages[stage]);
  return passed.length === 0 ? 'no gates' : passed.join(' ');
}

/**
 * The `--plain` projection: four line shapes and nothing else, so a script can
 * read a run with `grep` and a human can read it without a JSON parser.
 *
 *   phase: implementing
 *   task T001: done (typecheck lint test)
 *   review: passed
 *   done: 3 tasks
 */
export function createStdoutTextSink(opts: StdoutTextSinkOptions = {}): EventSink {
  const output = opts.output ?? process.stdout;
  const gates = new Map<string, string>();
  let lastPhase: string | null = null;
  let completed = 0;
  let gatelessRunAnnounced = false;

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
      case 'validate':
        if (bounded.status !== 'done') return;
        gates.set(bounded.taskId, passedGates(bounded));
        return;
      case 'warning':
        // The validator decides that the project matches no stack and says so
        // on this code; the sink repeats that verdict once, never re-derives it.
        if (gatelessRunAnnounced || bounded.code !== NO_GATES_WARNING.code) return;
        gatelessRunAnnounced = true;
        write('gates: NONE — review-only');
        return;
      case 'task_completed':
        completed += 1;
        write(`task ${bounded.taskId}: done (${gates.get(bounded.taskId) ?? 'no gates'})`);
        return;
      case 'task_full_fail':
        write(
          `task ${bounded.taskId}: failed (${bounded.reason ?? gates.get(bounded.taskId) ?? 'no gates'})`,
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
        write(`done: ${completed} tasks`);
        return;
      }
      default:
        return;
    }
  };
}

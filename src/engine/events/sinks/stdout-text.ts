import { formatTokensShort } from '../../../core/formatting.js';
import { boundEngineEventForConsumer } from '../bound.js';
import type { EngineEvent, EventSink } from '../types.js';

export interface StdoutTextSinkOptions {
  output?: NodeJS.WritableStream | undefined;
}

const VALIDATION_STAGES = ['typecheck', 'lint', 'test'] as const;

function passedGates(event: Extract<EngineEvent, { type: 'validate' }>): string {
  const passed = VALIDATION_STAGES.filter((stage) => event.stages[stage]);
  return passed.length === 0 ? 'no gates' : passed.join(' ');
}

function totalTokens(usage: Extract<EngineEvent, { type: 'cost_update' }>['tokenUsage']): number {
  return (
    usage.plannerInput +
    usage.plannerOutput +
    usage.implementerInput +
    usage.implementerOutput +
    usage.escalationInput +
    usage.escalationOutput +
    usage.reviewerInput +
    usage.reviewerOutput
  );
}

/**
 * The `--plain` projection: four line shapes and nothing else, so a script can
 * read a run with `grep` and a human can read it without a JSON parser.
 *
 *   phase: implementing
 *   task T001: done (typecheck lint test)
 *   review: passed
 *   done: 3 tasks, 128.4k tokens
 *
 * Cost is reported in tokens, not dollars: the event stream carries token
 * counts, and the dollar figure needs a live model-price catalog that a sink
 * has no business holding.
 */
export function createStdoutTextSink(opts: StdoutTextSinkOptions = {}): EventSink {
  const output = opts.output ?? process.stdout;
  const gates = new Map<string, string>();
  let lastPhase: string | null = null;
  let completed = 0;
  let tokens = 0;

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
        if (bounded.status === 'done') gates.set(bounded.taskId, passedGates(bounded));
        return;
      case 'task_completed':
        completed += 1;
        write(`task ${bounded.taskId}: done (${gates.get(bounded.taskId) ?? 'no gates'})`);
        return;
      case 'task_full_fail':
        write(`task ${bounded.taskId}: failed (${gates.get(bounded.taskId) ?? 'no gates'})`);
        return;
      case 'task_skipped':
        write(`task ${bounded.taskId}: failed (skipped)`);
        return;
      case 'cost_update':
        tokens = totalTokens(bounded.tokenUsage);
        return;
      case 'planner_status':
        // A failed final review stays in `final-review` and says so in its
        // summary; a passing one has already transitioned to `complete` by the
        // time it publishes, and announces itself as `workflow_complete`.
        if (bounded.phase !== 'final-review' || bounded.status !== 'done') return;
        if (bounded.summary === undefined) return;
        write('review: failed');
        return;
      case 'workflow_complete':
        write('review: passed');
        write(`done: ${completed} tasks, ${formatTokensShort(tokens)} tokens`);
        return;
      default:
        return;
    }
  };
}

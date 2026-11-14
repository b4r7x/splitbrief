import { continueRunCommand } from '../../core/recovery/resume-command.js';
import {
  type TerminationSignal,
  withSignalHandlers,
  SIGNAL_EXIT_CODE,
} from '../../engine/orchestrator/signals.js';

/**
 * Runs `work` under the headless stop. The first SIGINT, SIGTERM or SIGHUP aborts the signal
 * `work` gets; work that cannot be cut, such as Apply, ignores it and finishes. The process
 * then exits with the code the shell gives that signal, unless `work` throws.
 */
export async function withHeadlessStop<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ stopped: boolean; value: T }> {
  const controller = new AbortController();
  let first: TerminationSignal | undefined;
  const { value } = await withSignalHandlers(
    (signal) => {
      first ??= signal;
      controller.abort();
    },
    () => work(controller.signal),
  );
  if (first !== undefined) process.exitCode = SIGNAL_EXIT_CODE[first];
  return { stopped: first !== undefined, value };
}

/** The stderr line a run stopped by a signal leaves: how to carry it on. */
export function writeRunStopped(sessionId: string): void {
  process.stderr.write(
    `Run ${sessionId} stopped. Continue with: ${continueRunCommand(sessionId)}\n`,
  );
}

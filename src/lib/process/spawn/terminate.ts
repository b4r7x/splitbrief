import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text/diagnostic.js';
import { abortProcess, killProcess, unregisterProcess } from '../registry.js';
import { SIGKILL_DELAY_MS } from '../termination.js';
import { abortError, defaultFatalRemediation, isFatalSignal, spawnPipeError } from './fatal.js';
import { clearIdleTimers } from './idle-timers.js';
import type {
  SpawnPipeCallbackResult,
  SpawnPipeFatalOutcome,
  SpawnPipeFatalSignal,
  SpawnRun,
} from './types.js';

type TerminationReason =
  | { kind: 'fatal'; signal: SpawnPipeFatalSignal }
  | { kind: 'error'; error: unknown }
  | { kind: 'stdin-incomplete'; cause?: unknown };

export function cleanup<T>(run: SpawnRun<T>): void {
  clearIdleTimers(run.idleTimers);
  run.removeAbortListener?.();
  run.removeAbortListener = undefined;
}

function fatalOutcome<T>(run: SpawnRun<T>, signal: SpawnPipeFatalSignal): SpawnPipeFatalOutcome {
  const stdoutMetadata = run.partialStdout.snapshot();
  const stderrMetadata = run.partialStderr.snapshot();
  const remediation = sanitizeTerminalDiagnosticText(signal.remediation).trim();
  return {
    state: signal.state,
    remediation: remediation || defaultFatalRemediation(signal.state),
    stdout: stdoutMetadata.text,
    stderr: stderrMetadata.text,
    stdoutMetadata,
    stderrMetadata,
  };
}

function closedWithin<T>(run: SpawnRun<T>, graceMs: number): Promise<void> {
  return new Promise<void>((resolveGrace) => {
    const grace = setTimeout(resolveGrace, graceMs);
    void run.closed.promise.then(() => {
      clearTimeout(grace);
      resolveGrace();
    });
  });
}

export function terminate<T>(run: SpawnRun<T>, reason: TerminationReason): void {
  if (run.phase !== 'active') return;
  cleanup(run);
  // A child that quits before it reads its prompt breaks the pipe under it
  // while its last words (a usage limit, a dead login) are still in flight,
  // so its output keeps reaching the callbacks until it closes.
  const draining = reason.kind === 'stdin-incomplete';
  run.phase = draining ? 'draining' : 'terminating';
  if (!draining) {
    run.proc.stdout?.pause();
    run.proc.stderr?.pause();
  }
  const settleTermination = (err: unknown, unregister: boolean) => {
    if (run.phase === 'settled') return;
    run.phase = 'settled';
    if (unregister) unregisterProcess(run.proc);
    run.reject(err);
  };
  // A reaping failure is the one outcome that must replace the first cause:
  // the tree could not be verified dead, and the caller has to know that
  // rather than trusting a terminal classification.
  void killProcess(run.proc, { group: run.opts.detached ?? false })
    .then(() => (draining ? closedWithin(run, SIGKILL_DELAY_MS) : undefined))
    .then(
      () =>
        settleTermination(
          reason.kind === 'fatal'
            ? fatalOutcome(run, reason.signal)
            : reason.kind === 'stdin-incomplete'
              ? spawnPipeError.stdinIncomplete(reason.cause, run.exit)
              : reason.error,
          true,
        ),
      (err) => settleTermination(err, false),
    );
}

export function terminateFatal<T>(run: SpawnRun<T>, signal: SpawnPipeFatalSignal): void {
  terminate(run, { kind: 'fatal', signal });
}

// Only callbacks that are contractually allowed to signal fatality are guarded by result:
// a `void` callback may legally return a value under TypeScript's return-type bivariance, so
// treating that value as a fatal signal would kill the child for a harmless expression body.
export function invokeGuarded<T>(
  run: SpawnRun<T>,
  callback: () => SpawnPipeCallbackResult,
): boolean {
  if (run.phase !== 'active') return false;
  try {
    const result = callback();
    if (result === undefined) return true;
    if (isFatalSignal(result)) {
      terminateFatal(run, result);
      return false;
    }
  } catch {
    terminateFatal(run, { state: 'callback-failure', remediation: '' });
    return false;
  }
  terminateFatal(run, { state: 'callback-failure', remediation: '' });
  return false;
}

export function invokeVoidGuarded<T>(run: SpawnRun<T>, callback: () => void): boolean {
  return invokeGuarded(run, () => {
    callback();
    return undefined;
  });
}

/** Stops the child when the signal aborts; true when the signal had already aborted. */
export function watchAbort<T>(run: SpawnRun<T>, signal: AbortSignal): boolean {
  const onAbort = () => {
    if (run.phase !== 'active') return;
    run.phase = 'terminating';
    cleanup(run);
    run.proc.stdout?.pause();
    run.proc.stderr?.pause();
    const settleAbort = (err: unknown, unregister: boolean) => {
      if (run.phase !== 'terminating') return;
      run.phase = 'settled';
      if (unregister) unregisterProcess(run.proc);
      run.reject(err);
    };
    void abortProcess(run.proc, signal, { group: run.opts.detached ?? false }).then(
      () => settleAbort(signal.reason ?? abortError(), true),
      (err) => settleAbort(err, false),
    );
  };
  signal.addEventListener('abort', onAbort, { once: true });
  run.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  if (!signal.aborted) return false;
  onAbort();
  return true;
}

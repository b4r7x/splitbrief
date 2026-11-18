import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text/diagnostic.js';
import { abortProcess, killProcess, unregisterProcess } from '../registry.js';
import { SIGKILL_DELAY_MS } from '../termination.js';
import { abortError, defaultFatalRemediation, isFatalSignal, spawnPipeError } from './fatal.js';
import { clearIdleTimers } from './idle-timers.js';
import type {
  SpawnClose,
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
  if (run.fatalDrain?.kind === 'grace') clearTimeout(run.fatalDrain.timer);
  run.fatalDrain = undefined;
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
  if (run.exit !== undefined) return Promise.resolve();
  return new Promise<void>((resolveGrace) => {
    const grace = setTimeout(resolveGrace, graceMs);
    void run.closed.promise.then(() => {
      clearTimeout(grace);
      resolveGrace();
    });
  });
}

function pauseOutput<T>(run: SpawnRun<T>): void {
  run.proc.stdout?.pause();
  run.proc.stderr?.pause();
}

function rejectRun<T>(run: SpawnRun<T>, err: unknown, unregister: boolean): void {
  if (run.phase === 'settled') return;
  run.phase = 'settled';
  cleanup(run);
  if (unregister) unregisterProcess(run.proc);
  run.reject(err);
}

export function finishClose<T>(run: SpawnRun<T>, { code, signal }: SpawnClose): void {
  unregisterProcess(run.proc);
  const stoppedForDrain =
    run.fatalDrain?.kind === 'reaping' &&
    run.fatalDrain.stoppingChild &&
    (signal === 'SIGTERM' || signal === 'SIGKILL');
  const failAfterClose = (err: unknown) => {
    if (run.phase !== 'active') return;
    if (isFatalSignal(err)) terminateFatal(run, err);
    else terminate(run, { kind: 'error', error: err });
  };
  try {
    Promise.resolve(run.opts.onClose(code, signal, stoppedForDrain)).then((value) => {
      if (run.phase !== 'active') return;
      run.phase = 'settled';
      cleanup(run);
      run.resolve(value);
    }, failAfterClose);
  } catch (err: unknown) {
    failAfterClose(err);
  }
}

export function reapDeferredFatal<T>(run: SpawnRun<T>): void {
  if (run.phase !== 'active' || run.fatalDrain?.kind !== 'grace') return;
  clearTimeout(run.fatalDrain.timer);
  run.fatalDrain = {
    kind: 'reaping',
    stoppingChild: run.proc.exitCode === null && run.proc.signalCode === null,
  };
  // Keep delivering both pipes through close. While the group is being reaped,
  // an abort, callback failure or output budget breach can still end delivery.
  void killProcess(run.proc, { group: run.opts.detached ?? false })
    .then(async () => {
      await closedWithin(run, SIGKILL_DELAY_MS);
      if (run.phase !== 'active') return undefined;
      // A descendant that left the group can keep an inherited descriptor open.
      if (run.exit === undefined) {
        run.proc.stdout?.destroy();
        run.proc.stderr?.destroy();
      }
      return run.closed.promise;
    })
    .then(
      (closed) => {
        if (run.phase === 'active' && closed !== undefined) finishClose(run, closed);
      },
      (err) => {
        if (run.phase !== 'active') return;
        pauseOutput(run);
        rejectRun(run, err, false);
      },
    );
}

export function terminate<T>(run: SpawnRun<T>, reason: TerminationReason): void {
  if (run.phase !== 'active') return;
  cleanup(run);
  // A child that quits before it reads its prompt breaks the pipe under it
  // while its last words (a usage limit, a dead login) are still in flight,
  // so its output keeps reaching the callbacks until it closes.
  const draining = reason.kind === 'stdin-incomplete';
  run.phase = draining ? 'draining' : 'terminating';
  if (!draining) pauseOutput(run);
  // A reaping failure is the one outcome that must replace the first cause:
  // the tree could not be verified dead, and the caller has to know that
  // rather than trusting a terminal classification.
  void killProcess(run.proc, { group: run.opts.detached ?? false })
    .then(() => (draining ? closedWithin(run, SIGKILL_DELAY_MS) : undefined))
    .then(
      () =>
        rejectRun(
          run,
          reason.kind === 'fatal'
            ? fatalOutcome(run, reason.signal)
            : reason.kind === 'stdin-incomplete'
              ? spawnPipeError.stdinIncomplete(reason.cause, run.exit)
              : reason.error,
          true,
        ),
      (err) => rejectRun(run, err, false),
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
      if (result.drainOutput === true) {
        if (run.phase !== 'active') return false;
        clearIdleTimers(run.idleTimers);
        run.fatalDrain ??= {
          kind: 'grace',
          timer: setTimeout(() => reapDeferredFatal(run), SIGKILL_DELAY_MS),
        };
        return true;
      }
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

/** Watches for cancellation and settlement. Returns true if the child is already stopping. */
export function watchAbort<T>(run: SpawnRun<T>): boolean {
  const { signal, settlementSignal } = run.opts;
  const settlement = settlementSignal === undefined ? undefined : new AbortController();
  const stop =
    settlement === undefined
      ? signal
      : AbortSignal.any([...(signal === undefined ? [] : [signal]), settlement.signal]);
  if (stop === undefined) return false;

  const onSettlement = () => {
    if (run.fatalDrain === undefined) settlement?.abort(settlementSignal?.reason);
  };
  const onAbort = () => {
    if (run.phase !== 'active') return;
    run.phase = 'terminating';
    cleanup(run);
    pauseOutput(run);
    void abortProcess(run.proc, stop, { group: run.opts.detached ?? false }).then(
      () => rejectRun(run, stop.reason ?? abortError(), true),
      (err) => rejectRun(run, err, false),
    );
  };
  if (settlementSignal?.aborted) onSettlement();
  else settlementSignal?.addEventListener('abort', onSettlement, { once: true });
  stop.addEventListener('abort', onAbort, { once: true });
  run.removeAbortListener = () => {
    stop.removeEventListener('abort', onAbort);
    settlementSignal?.removeEventListener('abort', onSettlement);
  };
  if (!stop.aborted) return false;
  onAbort();
  return true;
}

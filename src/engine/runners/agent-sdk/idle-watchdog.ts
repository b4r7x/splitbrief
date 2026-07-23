import type { RunnerCallRecorder } from '../../calls/recorder.js';
import { processError } from '../../../lib/process/errors.js';

interface IdleWatchdog {
  readonly killed: Promise<never>;
  reset: () => void;
  stop: () => void;
}

export function createIdleWatchdog(opts: {
  recorder: RunnerCallRecorder;
  onKill: (err: Error) => void;
  warnMs: number;
  killMs: number;
}): IdleWatchdog {
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  let rejectKilled: (err: Error) => void = () => {};
  const killed = new Promise<never>((_resolve, reject) => {
    rejectKilled = reject;
  });

  function arm(): void {
    warnTimer = setTimeout(() => {
      stalled = true;
      opts.recorder.stalled({ silentMs: opts.warnMs });
    }, opts.warnMs);
    killTimer = setTimeout(() => {
      const idleError = processError.idleTimeout({
        command: opts.recorder.context.runnerName ?? 'Agent SDK',
        idleMs: opts.killMs,
      });
      rejectKilled(idleError);
      opts.onKill(idleError);
    }, opts.killMs);
  }

  function stop(): void {
    clearTimeout(warnTimer);
    clearTimeout(killTimer);
  }

  function reset(): void {
    stop();
    if (stalled) {
      stalled = false;
      opts.recorder.stallCleared();
    }
    arm();
  }

  arm();

  return { killed, reset, stop };
}

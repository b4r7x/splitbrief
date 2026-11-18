export type TerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** The shell's exit code for a process stopped by each signal: 128 plus the signal number. */
export const SIGNAL_EXIT_CODE: Record<TerminationSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

const TERMINATION_SIGNALS: readonly TerminationSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const holders = new Set<(signal: TerminationSignal) => void>();

/**
 * Gives each termination signal to `listener` until `releaseTerminationSignals(listener)`. While
 * any holder has the signals, the stop of `onUnheldTerminationSignal` leaves them to the holders.
 */
export function holdTerminationSignals(listener: (signal: TerminationSignal) => void): void {
  holders.add(listener);
  for (const signal of TERMINATION_SIGNALS) process.on(signal, listener);
}

export function releaseTerminationSignals(listener: (signal: TerminationSignal) => void): void {
  holders.delete(listener);
  for (const signal of TERMINATION_SIGNALS) process.off(signal, listener);
}

/** Calls `stop` for each termination signal that arrives while no holder has the signals. */
export function onUnheldTerminationSignal(stop: (signal: TerminationSignal) => void): void {
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => {
      if (holders.size === 0) stop(signal);
    });
  }
}

export async function withSignalHandlers<T>(
  handler: (signal: TerminationSignal) => void | Promise<void>,
  fn: () => Promise<T>,
): Promise<{ cancelled: boolean; value: T }> {
  let receivedSignal = false;
  let pendingShutdown: Promise<void> | null = null;

  const onSignal = (signal: TerminationSignal) => {
    receivedSignal = true;
    pendingShutdown = Promise.resolve(handler(signal));
  };

  holdTerminationSignals(onSignal);
  try {
    const value = await fn();
    return { cancelled: receivedSignal, value };
  } finally {
    releaseTerminationSignals(onSignal);
    await pendingShutdown;
  }
}

export type TerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** The shell's exit code for a process stopped by each signal: 128 plus the signal number. */
export const SIGNAL_EXIT_CODE: Record<TerminationSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

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

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  try {
    const value = await fn();
    return { cancelled: receivedSignal, value };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    await pendingShutdown;
  }
}

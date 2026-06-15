export async function withSignalHandlers(
  handler: () => void | Promise<void>,
  fn: () => Promise<void>,
): Promise<{ cancelled: boolean }> {
  let receivedSignal = false;
  let pendingShutdown: Promise<void> | null = null;

  const onSignal = () => {
    receivedSignal = true;
    pendingShutdown = Promise.resolve(handler());
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  try {
    await fn();
    return { cancelled: receivedSignal };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    await pendingShutdown;
  }
}

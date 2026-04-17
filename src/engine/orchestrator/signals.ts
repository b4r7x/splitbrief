import type { OrchestratorCallbacks } from './types.js';
import { labelError } from '../../utils/format-errors.js';
import { emitWarning } from './events.js';

export async function withSignalHandlers(
  handler: () => void,
  fn: () => Promise<void>,
): Promise<{ cancelled: boolean }> {
  let receivedSignal = false;

  const onSignal = () => {
    receivedSignal = true;
    handler();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await fn();
    return { cancelled: receivedSignal };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export async function warnOnFailure(
  callbacks: OrchestratorCallbacks,
  action: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    emitWarning(callbacks, labelError(`Failed to ${action}`, err));
  }
}

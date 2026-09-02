import type { EventBus } from '../events/types.js';

export function publishIpcOperationalWarning(bus: EventBus, message: string, code: string): void {
  bus.publish({
    type: 'warning',
    ts: Date.now(),
    phase: 'idle',
    category: 'ipc',
    code,
    transcriptSafe: true,
    message,
  });
}

import type { SessionRef } from '../../../core/types/session-ref.js';
import { warnError } from '../../../lib/warn.js';

const deliveries = new Map<string, Map<string, Promise<void>>>();

function deliveryKey(ref: SessionRef): string {
  return `${ref.projectDir}\u0000${ref.sessionId}`;
}

export function trackMidCallDelivery(ref: SessionRef, id: string, promise: Promise<unknown>): void {
  const key = deliveryKey(ref);
  const pending = deliveries.get(key) ?? new Map<string, Promise<void>>();
  const tracked = promise
    .then(
      () => {},
      (err: unknown) => warnError('mid-call delivery failed', err),
    )
    .finally(() => {
      if (pending.get(id) === tracked) pending.delete(id);
      if (pending.size === 0 && deliveries.get(key) === pending) deliveries.delete(key);
    });
  pending.set(id, tracked);
  deliveries.set(key, pending);
}

export async function settleMidCallDeliveries(ref: SessionRef): Promise<void> {
  const key = deliveryKey(ref);
  while (true) {
    const pending = deliveries.get(key);
    if (pending === undefined) break;
    await Promise.all(pending.values());
  }
}

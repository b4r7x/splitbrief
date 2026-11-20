import type { EngineEvent } from '../../../engine/events/types.js';

/** Older runs stored only a count. Those receipts consume queued messages in insertion order. */
export function releasedMessageIds(
  event: EngineEvent,
  pending: ReadonlySet<string>,
): readonly string[] | undefined {
  if (event.type === 'message_injected_native') return [event.id];
  if (event.type === 'queue_drained') return event.ids ?? [...pending].slice(0, event.count);
  if (event.type === 'queue_cleared') return [...pending].slice(0, event.count);
  return undefined;
}

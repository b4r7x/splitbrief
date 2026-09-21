import type { EngineEvent, EventBus, EventSink } from './types.js';

export function createEventBus(): EventBus {
  const sinks = new Set<EventSink>();

  function publish(event: EngineEvent): void {
    // Snapshotting keeps one publication stable when a sink subscribes or unsubscribes
    // while handling it, while preserving insertion order and duplicate event IDs.
    for (const sink of [...sinks]) {
      try {
        sink(event);
      } catch {
        // A projection failure (disk, stream, renderer, or hook) is non-authoritative.
      }
    }
  }

  function subscribe(sink: EventSink): () => void {
    sinks.add(sink);
    return () => {
      sinks.delete(sink);
    };
  }

  return { publish, subscribe };
}

import type { EngineEvent, EventBus, EventSink } from './types.js';

export function createEventBus(): EventBus {
  const sinks = new Set<EventSink>();

  function publish(event: EngineEvent): void {
    // Sink failures are isolated: a crashing sink (disk full, render error, hostile hook)
    // must not tear down the engine mid-task. Errors should re-emerge via the bus itself
    // (the offending sink can publish a `warning` event before throwing, if it wants).
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        /* intentional swallow — see comment above */
      }
    }
  }

  function subscribe(sink: EventSink): () => void {
    sinks.add(sink);
    return () => {
      sinks.delete(sink);
    };
  }

  function unsubscribeAll(): void {
    sinks.clear();
  }

  return { publish, subscribe, unsubscribeAll };
}

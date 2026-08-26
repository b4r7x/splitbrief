import type { EngineEvent, EventBus, EventSink } from './types.js';
import { projectEngineEventForTranscriptPolicy } from './protection/transcript.js';

export function createEventBus(): EventBus {
  const sinks = new Set<EventSink>();

  function publish(event: EngineEvent): void {
    // Recovery callers invoke publish only after their evidence/state commit. The bus is
    // deliberately not a second authority: it does not persist, deduplicate, reinterpret,
    // or invoke providers. It only applies the canonical recovery projection at this
    // delivery boundary; consumer sinks may then apply their context-specific limits.
    const projected = projectRecoveryEvent(event);
    if (projected === null) return;

    // Snapshotting keeps one publication stable when a sink subscribes or unsubscribes
    // while handling it, while preserving insertion order and duplicate event IDs.
    for (const sink of [...sinks]) {
      try {
        sink(projected);
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

function projectRecoveryEvent(event: EngineEvent): EngineEvent | null {
  if (!event.type.startsWith('brief_recovery_')) return event;
  return projectEngineEventForTranscriptPolicy(event, false);
}

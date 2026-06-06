// Stateful selector — module-scoped cache, not a hook. Avoids per-render scans of large event lists.
import type { EngineEvent } from '../../engine/events/types.js';
import type { EventsState } from '../../stores/workflow/events.js';

function findLatestEventByTypeFrom<TType extends EngineEvent['type']>(
  events: readonly EngineEvent[],
  type: TType,
  startIndex: number,
): { event: Extract<EngineEvent, { type: TType }>; index: number } | undefined {
  for (let index = events.length - 1; index >= startIndex; index--) {
    const event = events[index];
    if (event?.type === type) {
      return { event: event as Extract<EngineEvent, { type: TType }>, index };
    }
  }
  return undefined;
}

export function createLatestEventByTypeSelector<TType extends EngineEvent['type']>(
  type: TType,
): (state: EventsState) => Extract<EngineEvent, { type: TType }> | undefined {
  let cachedEvents: readonly EngineEvent[] | null = null;
  let cachedEvent: Extract<EngineEvent, { type: TType }> | undefined;
  let cachedIndex = -1;

  return (state: EventsState) => {
    const events = state.events;
    if (events === cachedEvents) return cachedEvent;

    if (cachedEvents && cachedEvent && events[cachedIndex] === cachedEvent) {
      if (events.length >= cachedEvents.length) {
        const latestAdded = findLatestEventByTypeFrom(events, type, cachedEvents.length);
        if (latestAdded) {
          cachedEvents = events;
          cachedEvent = latestAdded.event;
          cachedIndex = latestAdded.index;
          return cachedEvent;
        }
        cachedEvents = events;
        return cachedEvent;
      }
    }

    if (cachedEvents && cachedEvent === undefined && events.length >= cachedEvents.length) {
      const previousTailIndex = cachedEvents.length - 1;
      if (previousTailIndex < 0 || events[previousTailIndex] === cachedEvents[previousTailIndex]) {
        const latestAdded = findLatestEventByTypeFrom(events, type, cachedEvents.length);
        cachedEvents = events;
        if (latestAdded) {
          cachedEvent = latestAdded.event;
          cachedIndex = latestAdded.index;
        }
        return cachedEvent;
      }
    }

    const latest = findLatestEventByTypeFrom(events, type, 0);
    cachedEvents = events;
    cachedEvent = latest?.event;
    cachedIndex = latest?.index ?? -1;
    return cachedEvent;
  };
}

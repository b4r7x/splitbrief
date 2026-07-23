import { groupEventsIntoSections } from '../../../core/sections/event-sections.js';
import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { eventsStore } from '../events.js';

let cachedEvents: EngineEvent[] | null = null;
let cachedSections: Section<EngineEvent>[] = [];

function computeSections(events: EngineEvent[]): Section<EngineEvent>[] {
  if (cachedEvents === events) return cachedSections;
  cachedEvents = events;
  cachedSections = groupEventsIntoSections(events);
  return cachedSections;
}

export function clearSectionsCache(): void {
  cachedEvents = null;
  cachedSections = [];
}

export function getSections(): Section<EngineEvent>[] {
  return computeSections(eventsStore.get().events);
}

export function useSections(): Section<EngineEvent>[] {
  const events = eventsStore.use((s) => s.events);
  return computeSections(events);
}

import { describe, it, expect } from 'vitest';
import { trimSectionsToViewport } from './viewport-trimming.js';
import type { TuiEvent } from '../../types.js';
import type { Section } from '../../utils/event-sections.js';

type DynamicSection = Extract<Section, { type: 'events' | 'active-task' }>;

function makeEventsSection(count: number, startIndex = 0): DynamicSection {
  const items: TuiEvent[] = Array.from({ length: count }, (_, i) => ({
    type: 'status' as const,
    text: `event-${i}`,
  }));
  return { type: 'events', items, startIndex };
}

function makeActiveTaskSection(count: number, startIndex = 0): DynamicSection {
  const items: TuiEvent[] = Array.from({ length: count }, (_, i) => ({
    type: 'status' as const,
    text: `task-event-${i}`,
  }));
  return { type: 'active-task', items, startIndex };
}

describe('trimSectionsToViewport', () => {
  it('returns all sections when total height fits in viewport', () => {
    const sections = [makeEventsSection(2)];
    const result = trimSectionsToViewport(sections, 0, 100, new Set());
    expect(result.visibleSections).toHaveLength(1);
    expect(result.visibleSections[0]).toEqual(sections[0]);
  });

  it('returns empty array for empty sections', () => {
    const result = trimSectionsToViewport([], 0, 100, new Set());
    expect(result.visibleSections).toEqual([]);
    expect(result.totalHeight).toBe(0);
  });

  it('trims sections from the top when viewport is small', () => {
    const sections = [
      makeEventsSection(5, 0),
      makeEventsSection(5, 5),
    ];
    // Each event is ~3 lines. 5 events = ~15 lines per section
    const result = trimSectionsToViewport(sections, 0, 10, new Set());
    expect(result.visibleSections.length).toBeLessThanOrEqual(2);
  });

  it('skips sections based on scrollOffset', () => {
    const sections = [
      makeEventsSection(3, 0),
      makeEventsSection(3, 3),
      makeEventsSection(3, 6),
    ];
    // Each section is ~9 lines (3 events × 3 lines each).
    // scrollOffset of 9 should skip the last section entirely.
    const result = trimSectionsToViewport(sections, 9, 20, new Set());
    expect(result.visibleSections.length).toBeLessThanOrEqual(2);
    // The last section should be skipped
    const lastOriginal = sections[2];
    const hasLast = result.visibleSections.some(s => s === lastOriginal);
    expect(hasLast).toBe(false);
  });

  it('includes active-task sections', () => {
    const sections: DynamicSection[] = [
      makeEventsSection(2, 0),
      makeActiveTaskSection(2, 2),
    ];
    const result = trimSectionsToViewport(sections, 0, 100, new Set());
    expect(result.visibleSections).toHaveLength(2);
    expect(result.visibleSections[1]!.type).toBe('active-task');
  });

  it('returns empty when scroll past end and trimming needed', () => {
    const sections = [makeEventsSection(10, 0), makeEventsSection(10, 10)];
    // Large content, small viewport, huge scrollOffset → skip everything
    const result = trimSectionsToViewport(sections, 1000, 5, new Set());
    expect(result.visibleSections).toEqual([]);
  });
});

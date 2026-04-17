import { describe, it, expect } from 'vitest';
import { trimRenderableItemsToViewport } from './viewport-trimming.js';
import { getRenderableConversationItems } from './renderable-conversation.js';
import type { DynamicSection } from './event-sections.js';
import type { TuiEvent } from '../types/events.js';
import { makeImplementerGenerate } from '#testing/helpers/events.js';

function makeEventsSection(count: number, startIndex = 0): DynamicSection {
  const items: TuiEvent[] = Array.from({ length: count }, (_, i) => ({
    type: 'planner-text' as const,
    ts: i,
    text: `event-${i}`,
  }));
  return { type: 'events', items, startIndex };
}

function makeActiveTaskSection(count: number, startIndex = 0): DynamicSection {
  const items: TuiEvent[] = Array.from({ length: count }, (_, i) => ({
    type: 'planner-text' as const,
    ts: i,
    text: `task-event-${i}`,
  }));
  return { type: 'active-task', items, startIndex };
}

describe('trimRenderableItemsToViewport', () => {
  it('returns all sections when total height fits in viewport', () => {
    const items = getRenderableConversationItems([makeEventsSection(2)], new Set());
    const result = trimRenderableItemsToViewport(items, 3, 0, 3);
    expect(result.visibleItems).toHaveLength(2);
    expect(result.visibleItems.map((item) => item.globalIndex)).toEqual([0, 1]);
    expect(result.trimTop).toBe(0);
  });

  it('returns empty array for empty sections', () => {
    const result = trimRenderableItemsToViewport([], 0, 0, 0);
    expect(result.visibleItems).toEqual([]);
    expect(result.trimTop).toBe(0);
  });

  it('keeps only the viewport window and reports trimTop for the first visible item block', () => {
    const sections = [
      makeEventsSection(5, 0),
      makeEventsSection(5, 5),
    ];
    const items = getRenderableConversationItems(sections, new Set());
    const result = trimRenderableItemsToViewport(items, 19, 9, 19);
    expect(result.visibleItems.map((item) => item.globalIndex)).toEqual([5, 6, 7, 8, 9]);
    expect(result.trimTop).toBe(0);
  });

  it('selects only item blocks that intersect the scrolled viewport', () => {
    const sections = [
      makeEventsSection(3, 0),
      makeEventsSection(3, 3),
      makeEventsSection(3, 6),
    ];
    const items = getRenderableConversationItems(sections, new Set());
    const result = trimRenderableItemsToViewport(items, 17, 7, 12);
    expect(result.visibleItems.map((item) => item.globalIndex)).toEqual([4, 5, 6]);
    expect(result.trimTop).toBe(0);
  });

  it('includes active-task items', () => {
    const sections: DynamicSection[] = [
      makeEventsSection(2, 0),
      makeActiveTaskSection(2, 2),
    ];
    const items = getRenderableConversationItems(sections, new Set());
    const result = trimRenderableItemsToViewport(items, 7, 0, 7);
    expect(result.visibleItems).toHaveLength(4);
    expect(result.visibleItems[3]?.globalIndex).toBe(3);
  });

  it('clamps oversized scroll offsets to the top of the content window', () => {
    const sections = [makeEventsSection(10, 0), makeEventsSection(10, 10)];
    const items = getRenderableConversationItems(sections, new Set());
    const result = trimRenderableItemsToViewport(items, 39, 0, 5);
    expect(result.visibleItems.map((item) => item.globalIndex)).toEqual([0, 1, 2]);
    expect(result.trimTop).toBe(0);
  });

  it('keeps expanded diff height in the trimmed window contract', () => {
    const sections: DynamicSection[] = [{
      type: 'events',
      startIndex: 0,
      items: [makeImplementerGenerate({ status: 'done', file: 'a.ts', diff: '+ a\n+ b\n+ c\n+ d\n+ e\n+ f' })],
    }];
    const items = getRenderableConversationItems(sections, new Set([0]));
    const result = trimRenderableItemsToViewport(items, items[0]?.height ?? 0, 2, 5);
    expect(items[0]?.height).toBeGreaterThan(2);
    expect(result.visibleItems[0]?.globalIndex).toBe(0);
    expect(result.trimTop).toBe(2);
  });
});

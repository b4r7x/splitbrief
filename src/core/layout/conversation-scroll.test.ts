import { describe, expect, it } from 'vitest';
import { computeConversationScroll } from './conversation-scroll.js';
import type { Section } from './event-sections.js';

function makeEventSection(count: number, startIndex = 0): Extract<Section, { type: 'events' }> {
  return {
    type: 'events',
    startIndex,
    items: Array.from({ length: count }, (_, ts) => ({ type: 'planner-text' as const, ts, text: `event-${ts}` })),
  };
}

describe('computeConversationScroll', () => {
  it('keeps anchored scroll stable across both growth and shrinkage', () => {
    const sections = [makeEventSection(6)];
    const expandedDiffs = new Set<number>();

    const grown = computeConversationScroll({
      sections,
      expandedDiffs,
      cols: 80,
      viewportHeight: 4,
      rawScrollOffset: 3,
      renderableCountAtScroll: 4,
      heightAtScroll: 5,
    });

    const shrunk = computeConversationScroll({
      sections: [makeEventSection(4)],
      expandedDiffs,
      cols: 80,
      viewportHeight: 4,
      rawScrollOffset: 3,
      renderableCountAtScroll: 6,
      heightAtScroll: 9,
    });

    expect(grown.scrollOffset).toBeGreaterThanOrEqual(3);
    expect(shrunk.scrollOffset).toBeLessThanOrEqual(3);
  });

  it('ignores chrome-only arrivals when computing new events', () => {
    const sections: Section[] = [
      {
        type: 'events',
        startIndex: 0,
        items: [
          { type: 'planner-text', ts: 0, text: 'visible' },
          { type: 'planner-status', ts: 1, phase: 'planning', status: 'running' },
          {
            type: 'workflow-config',
            ts: 2,
            mode: 'standard',
            plannerTool: 'claude-code',
            implementerTool: 'ollama',
          },
        ],
      },
    ];

    const result = computeConversationScroll({
      sections,
      expandedDiffs: new Set(),
      cols: 80,
      viewportHeight: 4,
      rawScrollOffset: 1,
      renderableCountAtScroll: 1,
      heightAtScroll: 1,
    });

    expect(result.renderableCount).toBe(1);
    expect(result.newEventCount).toBe(0);
  });
});

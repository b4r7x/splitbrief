import { describe, expect, it } from 'vitest';
import type { Section } from './event-sections.js';
import { getMaxVisibleDiffLines } from './diff-height.js';
import {
  estimateRenderableConversationHeight,
  getRenderableConversationItems,
  isChromeEvent,
} from './renderable-conversation.js';
import {
  makePlannerText,
  makeImplementerGenerate,
} from '#testing/helpers/events.js';

function estimateSectionHeight(section: Section, expandedDiffs: Set<number>, cols?: number, rows?: number): number {
  if (section.type === 'completed-task') return 1;
  return estimateRenderableConversationHeight(
    getRenderableConversationItems([section], expandedDiffs, cols, rows),
  );
}

describe('estimateSectionHeight', () => {
  it('returns 1 for completed-task section', () => {
    const section: Section = {
      type: 'completed-task',
      summary: { index: 1, title: 'Task', method: 'local', retries: 0, duration: 5 },
    };
    expect(estimateSectionHeight(section, new Set())).toBe(1);
  });

  it('sums event heights for events section', () => {
    const section: Section = {
      type: 'events',
      items: [makePlannerText(), makePlannerText()],
      startIndex: 0,
    };
    expect(estimateSectionHeight(section, new Set())).toBe(3);
  });

  it('accounts for diff expanded state', () => {
    const section: Section = {
      type: 'events',
      items: [makeImplementerGenerate({ status: 'done', diff: '+ line' })],
      startIndex: 5,
    };
    const collapsed = estimateSectionHeight(section, new Set());
    const expanded = estimateSectionHeight(section, new Set([5]));
    expect(expanded).toBeGreaterThan(collapsed);
  });

  it('matches the shared diff row budget for expanded diffs', () => {
    const diff = Array.from({ length: 20 }, (_, index) => `+ line ${index}`).join('\n');
    const section: Section = {
      type: 'events',
      items: [makeImplementerGenerate({ status: 'done', file: 'a.ts', diff })],
      startIndex: 0,
    };
    const rows = 12;
    const visibleLines = Math.min(20, getMaxVisibleDiffLines(rows));
    const expected = 1 + (1 + visibleLines + 1);
    expect(estimateSectionHeight(section, new Set([0]), 80, rows)).toBe(expected);
  });
});

describe('isChromeEvent', () => {
  it('marks planner status and workflow config as chrome-only events', () => {
    expect(isChromeEvent('planner-status')).toBe(true);
    expect(isChromeEvent('workflow-config')).toBe(true);
  });

  it('keeps regular conversation events in the scroll region', () => {
    expect(isChromeEvent('planner-text')).toBe(false);
    expect(isChromeEvent('user-message')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { estimateSectionHeight, findLatestDiffEventIndex } from './section-heights.js';
import type { Section } from '../../core/event-sections.js';
import {
  makePlannerText,
  makeImplementerGenerate,
  makeValidate,
} from '#testing/helpers/events.js';

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
    const height = estimateSectionHeight(section, new Set());
    // 2 events × (1 line each) + 1 spacer between = 3 rows
    expect(height).toBe(3);
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
});

describe('findLatestDiffEventIndex', () => {
  it('returns null for empty events', () => {
    expect(findLatestDiffEventIndex([])).toBeNull();
  });

  it('returns null when no implementer-generate with done status and diff', () => {
    const events = [makePlannerText(), makeValidate()];
    expect(findLatestDiffEventIndex(events)).toBeNull();
  });

  it('returns index of last matching event', () => {
    const events = [
      makeImplementerGenerate({ status: 'done', diff: '+ first' }),
      makePlannerText(),
      makeImplementerGenerate({ status: 'done', diff: '+ second' }),
    ];
    expect(findLatestDiffEventIndex(events)).toBe(2);
  });

  it('ignores running status events', () => {
    const events = [
      makeImplementerGenerate({ status: 'done', diff: '+ line' }),
      makeImplementerGenerate({ status: 'running' }),
    ];
    expect(findLatestDiffEventIndex(events)).toBe(0);
  });
});

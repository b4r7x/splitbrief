import { describe, expect, it } from 'vitest';
import { getCompletedTaskSummaryRows } from './completed-task-summary-rows.js';
import type { Section } from './event-sections.js';

function completedSection(index: number): Extract<Section, { type: 'completed-task' }> {
  return {
    type: 'completed-task',
    items: [],
    startIndex: index,
    summary: {
      index,
      title: `done-${index}`,
      method: 'local',
      retries: 0,
      duration: 1,
    },
  };
}

describe('getCompletedTaskSummaryRows', () => {
  it('reserves no more rows than the viewport can show', () => {
    const sections: Section[] = [completedSection(1), completedSection(2), completedSection(3)];

    expect(getCompletedTaskSummaryRows(sections, 2)).toBe(2);
    expect(getCompletedTaskSummaryRows(sections, 10)).toBe(3);
    expect(getCompletedTaskSummaryRows(sections, 0)).toBe(0);
  });

  it('leaves one row for live dynamic content', () => {
    const sections: Section[] = [
      completedSection(1),
      completedSection(2),
      { type: 'events', startIndex: 2, items: [{ type: 'planner_text' }] },
    ];

    expect(getCompletedTaskSummaryRows(sections, 2)).toBe(1);
    expect(getCompletedTaskSummaryRows(sections, 1)).toBe(0);
  });
});

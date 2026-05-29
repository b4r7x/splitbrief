import { describe, expect, it } from 'vitest';
import { getCompletedTaskSummaryRows } from './completed-task-summary-rows.js';
import type { Section } from './event-sections.js';

function completedSection(index: number): Extract<Section, { type: 'completed-task' }> {
  return {
    type: 'completed-task',
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
});

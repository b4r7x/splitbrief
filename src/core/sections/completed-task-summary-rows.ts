import type { Section } from './event-sections.js';

export function getCompletedTaskSummaryRows(sections: Section[], viewportHeight: number): number {
  const completedCount = sections.filter((section) => section.type === 'completed-task').length;
  return Math.min(completedCount, Math.max(0, viewportHeight));
}

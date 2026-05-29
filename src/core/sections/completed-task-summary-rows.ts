import type { SectionableEvent, Section } from './event-sections.js';

export function getCompletedTaskSummaryRows<TEvent extends SectionableEvent>(
  sections: Section<TEvent>[],
  viewportHeight: number,
): number {
  const completedCount = sections.filter((section) => section.type === 'completed-task').length;
  return Math.min(completedCount, Math.max(0, viewportHeight));
}

import type { Section } from './event-sections.js';

export function getCompletedTaskSummaryRows(sections: Section[], viewportHeight: number): number {
  const completedCount = sections.filter((section) => section.type === 'completed-task').length;
  const hasDynamicContent = sections.some(
    (section) => section.type !== 'completed-task' && section.items.length > 0,
  );
  const reservedDynamicRows = hasDynamicContent ? 1 : 0;
  return Math.min(completedCount, Math.max(0, viewportHeight - reservedDynamicRows));
}

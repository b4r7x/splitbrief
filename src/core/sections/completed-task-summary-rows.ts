import { isSettledSection, type Section } from './event-sections.js';

export function getCompletedTaskSummaryRows(sections: Section[], viewportHeight: number): number {
  const completedCount = sections.filter(isSettledSection).length;
  const hasDynamicContent = sections.some(
    (section) => !isSettledSection(section) && section.items.length > 0,
  );
  const reservedDynamicRows = hasDynamicContent ? 1 : 0;
  return Math.min(completedCount, Math.max(0, viewportHeight - reservedDynamicRows));
}

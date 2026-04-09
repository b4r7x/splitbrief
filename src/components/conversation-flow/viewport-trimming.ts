import type { Section } from '../../utils/event-sections.js';
import { estimateSectionHeight } from '../../utils/event-sections.js';

type DynamicSection = Extract<Section, { type: 'events' | 'active-task' }>;

interface ViewportTrimResult {
  visibleSections: DynamicSection[];
  totalHeight: number;
}

export function trimSectionsToViewport(
  sections: DynamicSection[],
  scrollOffset: number,
  viewportHeight: number,
  expandedDiffs: Set<number>,
): ViewportTrimResult {
  const totalHeight = sections.reduce(
    (sum, s) => sum + estimateSectionHeight(s, expandedDiffs),
    0,
  );
  const needsTrim = totalHeight > viewportHeight;

  if (!needsTrim) {
    return { visibleSections: [...sections], totalHeight };
  }

  let remainingHeight = viewportHeight;
  const visibleSections: DynamicSection[] = [];
  let skipLines = scrollOffset;

  for (let i = sections.length - 1; i >= 0 && remainingHeight > 0; i--) {
    const section = sections[i]!;
    const sectionHeight = estimateSectionHeight(section, expandedDiffs);

    if (skipLines >= sectionHeight) {
      skipLines -= sectionHeight;
      continue;
    }

    const usable = sectionHeight - skipLines;
    skipLines = 0;

    if (usable <= remainingHeight) {
      visibleSections.unshift(section);
      remainingHeight -= usable;
    } else {
      visibleSections.unshift(section);
      remainingHeight = 0;
    }
  }

  return { visibleSections, totalHeight };
}

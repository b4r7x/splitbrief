import {
  computeListDisplayWindow,
  isItemIndexVisible,
} from '../../components/pickers/scroll-window.js';
import type { PageNavigationContext } from '../../hooks/use-filterable-list.js';
import { settingsItemSection, type SettingsItem } from './items.js';

/** Below this the blank row between sections costs a setting, so the sections close up. */
const SECTION_GAP_MIN_ROWS = 18;

function isReviewSeat(item: SettingsItem): boolean {
  return item.kind === 'crew' && item.row.id === 'review';
}

/**
 * The rows the settings list shows in `rowBudget`: its sections, the verdict line under the
 * REVIEW seat while `verdict` holds, and the crew block pinned at the head.
 */
export function settingsListWindow(input: {
  items: SettingsItem[];
  rowBudget: number;
  verdict: boolean;
}) {
  const section = {
    by: settingsItemSection,
    gapBetweenSections: input.rowBudget >= SECTION_GAP_MIN_ROWS,
  };
  const decorations = {
    after: (item: SettingsItem) => input.verdict && isReviewSeat(item),
  };
  /** Keeps the crew block pinned at the head of the list. */
  const pinnedHead = input.items.filter((item) => item.kind === 'crew').length;
  const windowInput = (list: SettingsItem[], selectedIndex: number) => ({
    items: list,
    selectedIndex,
    rowBudget: input.rowBudget,
    section,
    decorations,
    pinnedHead,
  });
  return {
    section,
    decorations,
    pinnedHead,
    pageSize: ({ filtered, selectedIndex }: PageNavigationContext<SettingsItem>) =>
      computeListDisplayWindow(windowInput(filtered, selectedIndex)).visibleSlots.filter(
        (slot) => slot.kind === 'item',
      ).length,
    canActOnIndex: (filtered: SettingsItem[], index: number) =>
      isItemIndexVisible(windowInput(filtered, index)),
  };
}

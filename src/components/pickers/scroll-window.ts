export function availableRows(rows: number, chrome: number, floor = 0): number {
  return Math.max(rows - chrome, floor);
}

export function computeScrollOffset(opts: {
  index: number;
  windowSize: number;
  totalItems: number;
}): number {
  const { index, windowSize, totalItems } = opts;
  if (totalItems <= windowSize) return 0;
  const half = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(index - half, totalItems - windowSize));
}

export function windowSlice<T>(items: T[], selectedIndex: number, windowSize: number) {
  const scrollOffset = computeScrollOffset({
    index: selectedIndex,
    windowSize,
    totalItems: items.length,
  });
  return {
    scrollOffset,
    visibleSlice: items.slice(scrollOffset, scrollOffset + windowSize),
    showScrollUp: scrollOffset > 0,
    showScrollDown: scrollOffset + windowSize < items.length,
  };
}

export function computeScrollWindow<T>(opts: {
  items: T[];
  selectedIndex: number;
  terminalRows: number;
  chromeRows: number;
  maxVisible?: number | undefined;
  listFloor?: number | undefined;
}) {
  const { items, selectedIndex, terminalRows, chromeRows, maxVisible, listFloor = 0 } = opts;
  const base = availableRows(terminalRows, chromeRows, listFloor);
  const visible = maxVisible !== undefined ? Math.min(base, maxVisible) : base;
  const scrollOffset = computeScrollOffset({
    index: selectedIndex,
    windowSize: visible,
    totalItems: items.length,
  });
  const visibleSlice = items.slice(scrollOffset, scrollOffset + visible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + visible < items.length;
  return { maxVisible: visible, scrollOffset, visibleSlice, showScrollUp, showScrollDown };
}

export interface SectionedDisplaySlot<T> {
  kind: 'header' | 'item';
  item: T;
  itemIndex: number;
  section: string | null;
}

export function buildSectionedDisplaySlots<T>(
  items: T[],
  sectionBy: (item: T) => string,
  sectionGap = false,
): SectionedDisplaySlot<T>[] {
  const slots: SectionedDisplaySlot<T>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const section = sectionBy(item);
    const prev = i > 0 ? items[i - 1] : undefined;
    const prevSection = prev !== undefined ? sectionBy(prev) : null;
    if (section !== prevSection) {
      if (sectionGap && slots.length > 0) {
        slots.push({ kind: 'header', item, itemIndex: i, section: '__gap__' });
      }
      slots.push({ kind: 'header', item, itemIndex: i, section });
    }
    slots.push({ kind: 'item', item, itemIndex: i, section });
  }
  return slots;
}

export function computeSectionedScrollWindow<T>(opts: {
  items: T[];
  selectedIndex: number;
  terminalRows: number;
  chromeRows: number;
  maxVisible?: number | undefined;
  sectionBy: (item: T) => string;
  sectionGap?: boolean | undefined;
  listFloor?: number | undefined;
}) {
  const {
    items,
    selectedIndex,
    terminalRows,
    chromeRows,
    maxVisible,
    sectionBy,
    sectionGap = false,
    listFloor = 0,
  } = opts;
  const slots = buildSectionedDisplaySlots(items, sectionBy, sectionGap);
  const selectedSlotIndex = Math.max(
    0,
    slots.findIndex((slot) => slot.kind === 'item' && slot.itemIndex === selectedIndex),
  );
  const base = availableRows(terminalRows, chromeRows, listFloor);
  const visible = maxVisible !== undefined ? Math.min(base, maxVisible) : base;
  const scrollOffset = computeScrollOffset({
    index: selectedSlotIndex,
    windowSize: visible,
    totalItems: slots.length,
  });
  const visibleSlots = slots.slice(scrollOffset, scrollOffset + visible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + visible < slots.length;
  return { maxVisible: visible, scrollOffset, visibleSlots, showScrollUp, showScrollDown };
}

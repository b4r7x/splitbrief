export function availableRows(opts: {
  rows: number;
  chromeRows: number;
  floor?: number | undefined;
}): number {
  return Math.max(opts.rows - opts.chromeRows, opts.floor ?? 0);
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

export function windowSlice<T>(opts: { items: T[]; selectedIndex: number; windowSize: number }) {
  const { items, selectedIndex, windowSize } = opts;
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

export type ListDisplaySlot<T> =
  | { kind: 'indicator'; direction: 'up' | 'down' }
  | { kind: 'header'; itemIndex: number; section: string }
  | { kind: 'gap'; itemIndex: number }
  | { kind: 'item'; item: T; itemIndex: number; section: string | null };

interface ListSectionOptions<T> {
  by: (item: T) => string;
  gapBetweenSections?: boolean | undefined;
}

interface ListDisplayWindowInput<T> {
  items: T[];
  selectedIndex: number;
  rowBudget?: number | undefined;
  terminalRows?: number | undefined;
  chromeRows?: number | undefined;
  maxVisible?: number | undefined;
  listFloor?: number | undefined;
  section?: ListSectionOptions<T> | undefined;
}

function clampWindowSize(windowSize: number, totalItems: number): number {
  if (totalItems <= 0) return 0;
  return Math.max(1, Math.min(windowSize, totalItems));
}

function buildListDisplaySlots<T>(
  items: T[],
  section: ListSectionOptions<T> | undefined,
): ListDisplaySlot<T>[] {
  if (!section) {
    return items.map((item, itemIndex) => ({ kind: 'item', item, itemIndex, section: null }));
  }

  const slots: ListDisplaySlot<T>[] = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (item === undefined) continue;

    const current = section.by(item);
    const previous = itemIndex > 0 ? items[itemIndex - 1] : undefined;
    const previousSection = previous === undefined ? null : section.by(previous);
    if (current !== previousSection) {
      if (section.gapBetweenSections && slots.length > 0) {
        slots.push({ kind: 'gap', itemIndex });
      }
      slots.push({ kind: 'header', itemIndex, section: current });
    }
    slots.push({ kind: 'item', item, itemIndex, section: current });
  }
  return slots;
}

function resolveRowBudget<T>(opts: ListDisplayWindowInput<T>): number {
  if (opts.rowBudget !== undefined) return Math.max(0, Math.floor(opts.rowBudget));

  const terminalRows = opts.terminalRows ?? 0;
  const chromeRows = opts.chromeRows ?? 0;
  const available = availableRows({
    rows: terminalRows,
    chromeRows,
    floor: opts.listFloor ?? 0,
  });
  return opts.maxVisible === undefined ? available : Math.min(available, opts.maxVisible);
}

function selectedDisplaySlotIndex<T>(slots: ListDisplaySlot<T>[], selectedIndex: number): number {
  const index = slots.findIndex((slot) => slot.kind === 'item' && slot.itemIndex === selectedIndex);
  return Math.max(0, index);
}

function computeContentWindow(opts: {
  totalSlots: number;
  selectedSlotIndex: number;
  rowBudget: number;
}): {
  contentRows: number;
  scrollOffset: number;
  showScrollUp: boolean;
  showScrollDown: boolean;
} {
  const { totalSlots, selectedSlotIndex, rowBudget } = opts;
  if (totalSlots <= rowBudget) {
    return { contentRows: totalSlots, scrollOffset: 0, showScrollUp: false, showScrollDown: false };
  }

  if (rowBudget <= 1) {
    return {
      contentRows: clampWindowSize(1, totalSlots),
      scrollOffset: Math.min(selectedSlotIndex, Math.max(0, totalSlots - 1)),
      showScrollUp: false,
      showScrollDown: false,
    };
  }

  if (rowBudget === 2) {
    const scrollOffset = Math.min(selectedSlotIndex, Math.max(0, totalSlots - 1));
    return {
      contentRows: 1,
      scrollOffset,
      showScrollUp: scrollOffset > 0,
      showScrollDown: scrollOffset === 0 && totalSlots > 1,
    };
  }

  let contentRows = clampWindowSize(rowBudget - 2, totalSlots);
  let scrollOffset = 0;
  let showScrollUp = false;
  let showScrollDown = false;

  for (let i = 0; i < 4; i++) {
    scrollOffset = computeScrollOffset({
      index: selectedSlotIndex,
      windowSize: contentRows,
      totalItems: totalSlots,
    });
    showScrollUp = scrollOffset > 0;
    showScrollDown = scrollOffset + contentRows < totalSlots;

    const nextContentRows = clampWindowSize(
      rowBudget - Number(showScrollUp) - Number(showScrollDown),
      totalSlots,
    );
    if (nextContentRows === contentRows) break;
    contentRows = nextContentRows;
  }

  return { contentRows, scrollOffset, showScrollUp, showScrollDown };
}

export function isItemIndexVisible<T>(opts: {
  items: T[];
  selectedIndex: number;
  rowBudget: number;
  section?: ListSectionOptions<T> | undefined;
}): boolean {
  if (opts.rowBudget <= 0 || opts.items.length === 0) return false;
  const { visibleSlots } = computeListDisplayWindow({
    items: opts.items,
    selectedIndex: opts.selectedIndex,
    rowBudget: opts.rowBudget,
    ...(opts.section ? { section: opts.section } : {}),
  });
  return visibleSlots.some((slot) => slot.kind === 'item' && slot.itemIndex === opts.selectedIndex);
}

export function computeListDisplayWindow<T>(opts: ListDisplayWindowInput<T>) {
  const rowBudget = resolveRowBudget(opts);
  const slots = buildListDisplaySlots(opts.items, opts.section);

  if (rowBudget <= 0 || slots.length === 0) {
    return {
      rowBudget,
      scrollOffset: 0,
      visibleSlots: [],
      showScrollUp: false,
      showScrollDown: false,
    };
  }

  const selectedSlot = selectedDisplaySlotIndex(slots, opts.selectedIndex);
  const { contentRows, scrollOffset, showScrollUp, showScrollDown } = computeContentWindow({
    totalSlots: slots.length,
    selectedSlotIndex: selectedSlot,
    rowBudget,
  });
  const content = slots.slice(scrollOffset, scrollOffset + contentRows);
  const visibleSlots: ListDisplaySlot<T>[] = [];
  if (showScrollUp) visibleSlots.push({ kind: 'indicator', direction: 'up' });
  visibleSlots.push(...content);
  if (showScrollDown) visibleSlots.push({ kind: 'indicator', direction: 'down' });

  return {
    rowBudget,
    scrollOffset,
    visibleSlots,
    showScrollUp,
    showScrollDown,
  };
}

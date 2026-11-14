import type { RightSectionProps } from './types.js';
import {
  type RightItemOrVirtual,
  isVirtualCustomItem,
  CUSTOM_ROW_ID,
  isRealRightItem,
} from './virtual-items.js';

export type RightDisplaySlot<R> =
  | { kind: 'spacer'; key: string }
  | { kind: 'header'; key: string; section: string }
  | { kind: 'guidance'; key: string }
  | { kind: 'row'; key: string; item: RightItemOrVirtual<R>; navIndex: number };

export function buildRightDisplay<R extends { id: string }>(
  items: RightItemOrVirtual<R>[],
  getKey: (item: R) => string,
  section: RightSectionProps<R> | undefined,
): RightDisplaySlot<R>[] {
  const slots: RightDisplaySlot<R>[] = [];
  let previous: string | null = null;
  items.forEach((item, navIndex) => {
    const key = isVirtualCustomItem(item) ? CUSTOM_ROW_ID : getKey(item);
    if (section && isRealRightItem(item)) {
      const current = section.by(item);
      // A row that opens no section of its own — the children of an expansion —
      // leaves the open section standing, or the next row of it repeats its header.
      if (current !== '') {
        if (current !== previous && (section.headerFor?.(current) ?? true)) {
          if (slots.length > 0) {
            slots.push({ kind: 'spacer', key: `spacer:${current}` });
          }
          slots.push({ kind: 'header', key: `section:${current}`, section: current });
        }
        previous = current;
      }
    }
    slots.push({ kind: 'row', key, item, navIndex });
  });
  // The custom-model row is an affordance, not catalog content: with no real
  // row behind it the column still owes the reader why the catalog is empty.
  if (!items.some(isRealRightItem)) slots.push({ kind: 'guidance', key: 'guidance' });
  return slots;
}

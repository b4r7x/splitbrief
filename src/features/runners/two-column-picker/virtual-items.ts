export const CUSTOM_ROW_ID = '__custom__' as const;

export type VirtualCustomItem = { id: typeof CUSTOM_ROW_ID; isVirtual: true };
export type RightItemOrVirtual<R> = R | VirtualCustomItem;

export function isVirtualCustomItem<R extends { id: string }>(
  item: RightItemOrVirtual<R>,
): item is VirtualCustomItem {
  return 'isVirtual' in item;
}

export function isRealRightItem<R extends { id: string }>(item: RightItemOrVirtual<R>): item is R {
  return !isVirtualCustomItem(item);
}

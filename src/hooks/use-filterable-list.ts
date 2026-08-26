import { useEffect, useEffectEvent, useState } from 'react';
import { useInput, type Key } from 'ink';
import { clampIndex, navigateIndex } from '../utils/indexing.js';
import { assertNever } from '../utils/type-guards.js';
import { isTextEntryInput } from '../lib/terminal/text-entry.js';

export interface PageNavigationContext<T> {
  filtered: T[];
  selectedIndex: number;
}

export type PageSize<T> = number | ((ctx: PageNavigationContext<T>) => number);
type UpAtStart = 'wrap' | 'close';

export interface FilterableListKeyContext<T> {
  filtered: T[];
  selectedIndex: number;
  appendToFilter: (text: string) => void;
  runSelectedItemAction: () => void;
}

interface UseFilterableListOptions<T> {
  items: T[];
  getKey: (item: T) => string;
  filterFn: (item: T, query: string) => boolean;
  onSelect: (item: T) => void;
  onItemAction?: ((item: T) => void) | undefined;
  onClose?: (() => void) | undefined;
  upAtStart?: UpAtStart | undefined;
  isActive?: boolean | undefined;
  shouldAppendChar?: ((input: string) => boolean) | undefined;
  initialKey?: string | undefined;
  initialFilter?: string | undefined;
  pageSize: PageSize<T>;
  customKeys?: (input: string, key: Key, ctx: FilterableListKeyContext<T>) => boolean | undefined;
}

interface UseFilterableListResult<T> {
  filter: string;
  filtered: T[];
  selectedIndex: number;
  selectItem: (item: T) => void;
  runItemAction: (item: T) => void;
}

type Commit<T> = { kind: 'close' } | { kind: 'select'; item: T } | { kind: 'item-action'; item: T };
type ItemCommitKind = Exclude<Commit<never>['kind'], 'close'>;
type PendingCommit<T> = Commit<T> & { id: number };

interface FilterableListState<T> {
  filter: string;
  selectedKey: string | null;
  pendingCommits: PendingCommit<T>[];
  nextCommitId: number;
}

interface ListEnvironment<T> {
  items: T[];
  getKey: (item: T) => string;
  filterFn: (item: T, query: string) => boolean;
  pageSize: PageSize<T>;
  hasOnClose: boolean;
  hasOnItemAction: boolean;
  upAtStart: UpAtStart;
}

interface ListProjection<T> {
  filtered: T[];
  selectedIndex: number;
  selectedItem: T | undefined;
  selectedKey: string | null;
}

type ListAction =
  | { type: 'append'; text: string }
  | { type: 'item-action-selected' }
  | { type: 'key'; input: string; key: Key }
  | { type: 'select-key'; key: string }
  | { type: 'item-action-key'; key: string };

const getFilteredItems = <T>(
  items: T[],
  filterFn: (item: T, query: string) => boolean,
  filter: string,
): T[] => (filter ? items.filter((item) => filterFn(item, filter)) : items);

function rawPageSize<T>(pageSize: PageSize<T>, ctx: PageNavigationContext<T>): number {
  return typeof pageSize === 'number' ? pageSize : pageSize(ctx);
}

function projectList<T>(state: FilterableListState<T>, env: ListEnvironment<T>): ListProjection<T> {
  const filtered = getFilteredItems(env.items, env.filterFn, state.filter);
  const foundIndex =
    state.selectedKey === null
      ? -1
      : filtered.findIndex((item) => env.getKey(item) === state.selectedKey);
  const selectedIndex = foundIndex >= 0 ? foundIndex : 0;
  const selectedItem = filtered[selectedIndex];
  return {
    filtered,
    selectedIndex,
    selectedItem,
    selectedKey: selectedItem === undefined ? null : env.getKey(selectedItem),
  };
}

function hasPendingTerminal<T>(state: FilterableListState<T>): boolean {
  return state.pendingCommits.some((commit) => commit.kind !== 'item-action');
}

function selectIndex<T>(
  state: FilterableListState<T>,
  options: {
    projection: ListProjection<T>;
    index: number;
    getKey: (item: T) => string;
  },
): FilterableListState<T> {
  const item =
    options.projection.filtered[clampIndex(options.index, options.projection.filtered.length)];
  const selectedKey = item === undefined ? null : options.getKey(item);
  return selectedKey === state.selectedKey ? state : { ...state, selectedKey };
}

function queueCommit<T>(state: FilterableListState<T>, commit: Commit<T>): FilterableListState<T> {
  const pendingCommit: PendingCommit<T> = { ...commit, id: state.nextCommitId };
  return {
    ...state,
    pendingCommits: [...state.pendingCommits, pendingCommit],
    nextCommitId: state.nextCommitId + 1,
  };
}

function replaceFilter<T>(
  state: FilterableListState<T>,
  env: ListEnvironment<T>,
  filter: string,
): FilterableListState<T> {
  const filtered = getFilteredItems(env.items, env.filterFn, filter);
  return {
    ...state,
    filter,
    selectedKey: filtered[0] === undefined ? null : env.getKey(filtered[0]),
  };
}

function queueProjectedCommit<T>(
  state: FilterableListState<T>,
  env: ListEnvironment<T>,
  kind: ItemCommitKind,
): FilterableListState<T> {
  if (kind === 'item-action' && !env.hasOnItemAction) return state;
  const projection = projectList(state, env);
  const visibleRows = rawPageSize(env.pageSize, {
    filtered: projection.filtered,
    selectedIndex: projection.selectedIndex,
  });
  if (visibleRows <= 0 || projection.selectedItem === undefined) return state;
  return queueCommit(
    { ...state, selectedKey: projection.selectedKey },
    { kind, item: projection.selectedItem },
  );
}

function queueKeyedCommit<T>(
  state: FilterableListState<T>,
  env: ListEnvironment<T>,
  options: { targetKey: string; kind: ItemCommitKind },
): FilterableListState<T> {
  if (options.kind === 'item-action' && !env.hasOnItemAction) return state;
  const projection = projectList(state, env);
  const targetIndex = projection.filtered.findIndex(
    (item) => env.getKey(item) === options.targetKey,
  );
  if (targetIndex < 0) return state;
  const visibleRows = rawPageSize(env.pageSize, {
    filtered: projection.filtered,
    selectedIndex: targetIndex,
  });
  const item = projection.filtered[targetIndex];
  if (visibleRows <= 0 || item === undefined) return state;
  return queueCommit({ ...state, selectedKey: options.targetKey }, { kind: options.kind, item });
}

function reduceKey<T>(
  state: FilterableListState<T>,
  env: ListEnvironment<T>,
  action: Extract<ListAction, { type: 'key' }>,
): FilterableListState<T> {
  const { input, key } = action;
  const projection = projectList(state, env);

  if (key.escape) {
    return env.hasOnClose ? queueCommit(state, { kind: 'close' }) : state;
  }
  if (key.return) return queueProjectedCommit(state, env, 'select');
  if (key.upArrow || key.downArrow) {
    if (
      key.upArrow &&
      projection.selectedIndex === 0 &&
      env.upAtStart === 'close' &&
      env.hasOnClose
    ) {
      return queueCommit(state, { kind: 'close' });
    }
    const direction = key.upArrow ? 'up' : 'down';
    return selectIndex(state, {
      projection,
      index: navigateIndex(direction, projection.selectedIndex, projection.filtered.length),
      getKey: env.getKey,
    });
  }
  if (key.home || key.end) {
    return selectIndex(state, {
      projection,
      index: key.home ? 0 : projection.filtered.length - 1,
      getKey: env.getKey,
    });
  }
  if (key.pageUp || key.pageDown) {
    if (projection.filtered.length === 0) {
      return selectIndex(state, { projection, index: 0, getKey: env.getKey });
    }
    const distance = Math.max(
      1,
      rawPageSize(env.pageSize, {
        filtered: projection.filtered,
        selectedIndex: projection.selectedIndex,
      }),
    );
    const nextIndex = key.pageUp
      ? projection.selectedIndex - distance
      : projection.selectedIndex + distance;
    return selectIndex(state, { projection, index: nextIndex, getKey: env.getKey });
  }
  if (key.backspace || key.delete) {
    return replaceFilter(state, env, [...state.filter].slice(0, -1).join(''));
  }
  return isTextEntryInput(input, key) ? replaceFilter(state, env, state.filter + input) : state;
}

function reduceListAction<T>(
  state: FilterableListState<T>,
  env: ListEnvironment<T>,
  action: ListAction,
): FilterableListState<T> {
  if (hasPendingTerminal(state)) return state;
  if (action.type === 'append') return replaceFilter(state, env, state.filter + action.text);
  if (action.type === 'item-action-selected') {
    return queueProjectedCommit(state, env, 'item-action');
  }
  if (action.type === 'select-key') {
    return queueKeyedCommit(state, env, { targetKey: action.key, kind: 'select' });
  }
  if (action.type === 'item-action-key') {
    return queueKeyedCommit(state, env, {
      targetKey: action.key,
      kind: 'item-action',
    });
  }
  return reduceKey(state, env, action);
}

function reconcileSelection<T>(
  state: FilterableListState<T>,
  env: ListEnvironment<T>,
): FilterableListState<T> {
  const selectedKey = projectList(state, env).selectedKey;
  return selectedKey === state.selectedKey ? state : { ...state, selectedKey };
}

function consumeThrough<T>(
  state: FilterableListState<T>,
  lastCommitId: number,
): FilterableListState<T> {
  const pendingCommits = state.pendingCommits.filter(({ id }) => id > lastCommitId);
  return pendingCommits.length === state.pendingCommits.length
    ? state
    : { ...state, pendingCommits };
}

export function useFilterableList<T>({
  items,
  getKey,
  filterFn,
  onSelect,
  onItemAction,
  onClose,
  upAtStart = 'wrap',
  isActive = true,
  shouldAppendChar,
  initialKey,
  initialFilter,
  pageSize,
  customKeys,
}: UseFilterableListOptions<T>): UseFilterableListResult<T> {
  const [state, setState] = useState<FilterableListState<T>>(() => {
    const filter = initialFilter ?? '';
    const candidates = getFilteredItems(items, filterFn, filter);
    const initialItem =
      (initialKey === undefined
        ? undefined
        : candidates.find((item) => getKey(item) === initialKey)) ?? candidates[0];
    return {
      filter,
      selectedKey: initialItem === undefined ? null : getKey(initialItem),
      pendingCommits: [],
      nextCommitId: 1,
    };
  });
  const env: ListEnvironment<T> = {
    items,
    getKey,
    filterFn,
    pageSize,
    hasOnClose: onClose !== undefined,
    hasOnItemAction: onItemAction !== undefined,
    upAtStart,
  };
  const commit = useEffectEvent((entry: PendingCommit<T>) => {
    switch (entry.kind) {
      case 'close':
        onClose?.();
        return;
      case 'select':
        onSelect(entry.item);
        return;
      case 'item-action':
        onItemAction?.(entry.item);
        return;
      default:
        assertNever(entry);
    }
  });
  const reconcileItems = useEffectEvent(() => {
    setState((prev) => reconcileSelection(prev, env));
  });
  const appendToFilter = (text: string) => {
    setState((prev) => reduceListAction(prev, env, { type: 'append', text }));
  };
  const runSelectedItemAction = () => {
    setState((prev) => reduceListAction(prev, env, { type: 'item-action-selected' }));
  };

  const projection = projectList(state, env);
  const pendingCommits = state.pendingCommits;

  useEffect(() => {
    reconcileItems();
  }, [items]);

  useEffect(() => {
    const lastCommit = pendingCommits.at(-1);
    if (lastCommit === undefined) return;
    setState((prev) => consumeThrough(prev, lastCommit.id));
    for (const entry of pendingCommits) commit(entry);
  }, [pendingCommits]);

  useInput(
    (input, key) => {
      if (
        customKeys?.(input, key, {
          filtered: projection.filtered,
          selectedIndex: projection.selectedIndex,
          appendToFilter,
          runSelectedItemAction,
        })
      ) {
        return;
      }
      if (isTextEntryInput(input, key) && shouldAppendChar && !shouldAppendChar(input)) return;
      setState((prev) => reduceListAction(prev, env, { type: 'key', input, key }));
    },
    { isActive },
  );

  return {
    filter: state.filter,
    filtered: projection.filtered,
    selectedIndex: projection.selectedIndex,
    selectItem: (item) => {
      const key = getKey(item);
      setState((prev) => reduceListAction(prev, env, { type: 'select-key', key }));
    },
    runItemAction: (item) => {
      const key = getKey(item);
      setState((prev) => reduceListAction(prev, env, { type: 'item-action-key', key }));
    },
  };
}

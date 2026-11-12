import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { type ColumnStateHook, useColumnState } from './use-column-state.js';

interface ColumnRender {
  key: string | undefined;
  index: number;
  effectiveIndex: number;
}

interface ColumnProps {
  source: string[];
  initialIndex: number;
  virtualCount?: number;
}

function mountColumn(props: ColumnProps) {
  const renders: ColumnRender[] = [];
  const notified: (string | undefined)[] = [];
  let latest: ColumnStateHook<string> | undefined;
  function Column({ source, initialIndex, virtualCount }: ColumnProps) {
    const column = useColumnState({
      source,
      filterFn: (item, query) => item.includes(query),
      getKey: (item) => item,
      initialIndex,
      virtualCount,
      onCurrentItemChange: (item) => notified.push(item),
    });
    latest = column;
    renders.push({
      key: column.currentItem,
      index: column.index,
      effectiveIndex: column.effectiveIndex,
    });
    return <Text>{column.currentItem ?? 'virtual row'}</Text>;
  }
  const ui = renderFeature(<Column {...props} />);
  return {
    renders,
    notified,
    rerender: (source: string[]) => ui.rerender(<Column {...props} source={source} />),
    column: () => {
      if (latest === undefined) throw new Error('the column has not rendered');
      return latest;
    },
    unmount: ui.unmount,
  };
}

describe('useColumnState across a change of the source order', () => {
  it('keeps the selected key in every render after a reorder, and moves on from it', async () => {
    const col = mountColumn({ source: ['a', 'b', 'c'], initialIndex: 1 });
    await vi.waitFor(() => expect(col.notified).toEqual(['b']));
    const before = col.renders.length;

    col.rerender(['b', 'a', 'c']);
    await vi.waitFor(() =>
      expect(col.renders.at(-1)).toEqual({ key: 'b', index: 0, effectiveIndex: 0 }),
    );
    await flushEffects();

    const afterReorder = col.renders.slice(before);
    expect(afterReorder.length).toBeGreaterThan(0);
    expect(
      afterReorder.filter((r) => r.key !== 'b' || r.index !== 0 || r.effectiveIndex !== 0),
    ).toEqual([]);
    expect(col.notified).toEqual(['b']);

    expect(col.column().moveBy(1)).toBe('a');
    await vi.waitFor(() =>
      expect(col.renders.at(-1)).toEqual({ key: 'a', index: 1, effectiveIndex: 1 }),
    );
    expect(col.notified).toEqual(['b', 'a']);
    col.unmount();
  });

  it('keeps a cursor on a virtual row at its index across a reorder', async () => {
    const col = mountColumn({ source: ['a', 'b', 'c'], initialIndex: 2, virtualCount: 1 });
    await vi.waitFor(() => expect(col.notified).toEqual(['b']));
    expect(col.column().setIndex(0)).toBeUndefined();
    await vi.waitFor(() =>
      expect(col.renders.at(-1)).toEqual({ key: undefined, index: 0, effectiveIndex: 0 }),
    );
    const before = col.renders.length;

    col.rerender(['b', 'a', 'c']);
    await flushEffects();

    const afterReorder = col.renders.slice(before);
    expect(afterReorder.length).toBeGreaterThan(0);
    expect(
      afterReorder.filter((r) => r.key !== undefined || r.index !== 0 || r.effectiveIndex !== 0),
    ).toEqual([]);
    expect(col.notified).toEqual(['b', undefined]);
    col.unmount();
  });

  it('notifies the item at the index after a reset', async () => {
    const col = mountColumn({ source: ['a', 'b', 'c'], initialIndex: 1 });
    await vi.waitFor(() => expect(col.notified).toEqual(['b']));
    const before = col.renders.length;

    col.column().reset(0);
    await vi.waitFor(() => expect(col.notified).toEqual(['b', 'a']));
    await flushEffects();

    expect(col.renders.slice(before).filter((r) => r.key !== 'a')).toEqual([]);
    expect(col.renders.at(-1)).toEqual({ key: 'a', index: 0, effectiveIndex: 0 });
    expect(col.notified).toEqual(['b', 'a']);
    col.unmount();
  });

  it('stays at the index and notifies the new item once when the selected key leaves', async () => {
    const col = mountColumn({ source: ['a', 'b', 'c'], initialIndex: 1 });
    await vi.waitFor(() => expect(col.notified).toEqual(['b']));
    const before = col.renders.length;

    col.rerender(['a', 'c']);
    await vi.waitFor(() => expect(col.notified).toEqual(['b', 'c']));
    await flushEffects();

    expect(
      col.renders.slice(before).filter((r) => r.key !== 'c' || r.effectiveIndex !== 1),
    ).toEqual([]);
    expect(col.notified).toEqual(['b', 'c']);
    col.unmount();
  });

  it('clamps to the last row and notifies it once when the selected last key leaves', async () => {
    const col = mountColumn({ source: ['a', 'b', 'c'], initialIndex: 2 });
    await vi.waitFor(() => expect(col.notified).toEqual(['c']));
    const before = col.renders.length;

    col.rerender(['a', 'b']);
    await vi.waitFor(() => expect(col.notified).toEqual(['c', 'b']));
    await flushEffects();

    expect(
      col.renders.slice(before).filter((r) => r.key !== 'b' || r.effectiveIndex !== 1),
    ).toEqual([]);
    expect(col.notified).toEqual(['c', 'b']);
    col.unmount();
  });
});

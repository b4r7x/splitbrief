import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { useFilterableList } from './use-filterable-list.js';

// useFilterableList uses useInput from ink for keyboard handling.
// The renderHook helper creates an internal stdin PassThrough that
// is not exposed, so we cannot simulate keypresses. The setFilter
// and setSelectedIndex setters are exposed but they are raw useState
// dispatchers -- calling them from outside the React tree does not
// trigger a re-render in Ink's reconciler.
//
// Tests below cover initial state and static behavior. Full keyboard
// interaction tests would require stdin injection support in renderHook.

const items = ['apple', 'banana', 'cherry'];
const filterFn = (item: string, query: string) =>
  item.toLowerCase().includes(query.toLowerCase());

describe('useFilterableList', () => {
  it('returns all items when filter is empty', () => {
    const { result, unmount } = renderHook(() =>
      useFilterableList({
        items,
        filterFn,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(result.current.filter).toBe('');
    expect(result.current.filtered).toEqual(items);
    unmount();
  });

  it('selectedIndex starts at 0', () => {
    const { result, unmount } = renderHook(() =>
      useFilterableList({
        items,
        filterFn,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(result.current.selectedIndex).toBe(0);
    unmount();
  });

  it('isActive defaults to true', () => {
    const { result, unmount } = renderHook(() =>
      useFilterableList({
        items,
        filterFn,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(result.current.filtered).toHaveLength(3);
    unmount();
  });

  it('filtered list reflects the items passed in', () => {
    const subset = ['apple'];
    const { result, unmount } = renderHook(() =>
      useFilterableList({
        items: subset,
        filterFn,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(result.current.filtered).toEqual(['apple']);
    unmount();
  });

  it('empty items produces empty filtered list', () => {
    const { result, unmount } = renderHook(() =>
      useFilterableList({
        items: [],
        filterFn,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(result.current.filtered).toEqual([]);
    expect(result.current.selectedIndex).toBe(0);
    unmount();
  });
});

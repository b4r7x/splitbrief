import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { useFilterableList } from './use-filterable-list.js';

type KeyInfo = Record<string, boolean>;
type InputHandler = (input: string, key: KeyInfo) => void;

let capturedHandler: InputHandler | undefined;

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (handler: InputHandler, options?: { isActive?: boolean }) => {
      capturedHandler = options?.isActive === false ? undefined : handler;
    },
  };
});

const items = ['apple', 'banana', 'cherry'];
const filterFn = (item: string, query: string) =>
  item.toLowerCase().includes(query.toLowerCase());

const baseKey: KeyInfo = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, ctrl: false, meta: false, shift: false,
  backspace: false, delete: false, tab: false,
};

function press(overrides: Partial<KeyInfo>, input = '') {
  const merged: KeyInfo = { ...baseKey };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (merged as Record<string, boolean>)[k] = v;
  }
  capturedHandler!(input, merged);
}

beforeEach(() => {
  capturedHandler = undefined;
});

describe('useFilterableList', () => {
  it('typing narrows the filtered list', async () => {
    const { result, act, unmount } = renderHook(() =>
      useFilterableList({ items, filterFn, onSelect: vi.fn() }),
    );

    await act(() => press({}, 'a'));
    await act(() => press({}, 'n'));
    expect(result.current.filter).toBe('an');
    expect(result.current.filtered).toEqual(['banana']);
    unmount();
  });

  it('Enter calls onSelect with the selected item', async () => {
    const onSelect = vi.fn();
    const { act, unmount } = renderHook(() =>
      useFilterableList({ items, filterFn, onSelect }),
    );

    await act(() => press({ downArrow: true }));
    await act(() => press({ return: true }));
    expect(onSelect).toHaveBeenCalledWith('banana');
    unmount();
  });

  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    const { act, unmount } = renderHook(() =>
      useFilterableList({ items, filterFn, onSelect: vi.fn(), onClose }),
    );

    await act(() => press({ escape: true }));
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
  });

  it('Enter does nothing when filtered list is empty', async () => {
    const onSelect = vi.fn();
    const { act, unmount } = renderHook(() =>
      useFilterableList({ items, filterFn, onSelect }),
    );

    await act(() => press({}, 'x'));
    await act(() => press({}, 'y'));
    await act(() => press({}, 'z'));
    await act(() => press({ return: true }));
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps selectedIndex at 0 when navigating an empty filtered list', async () => {
    const { result, act, unmount } = renderHook(() =>
      useFilterableList({ items, filterFn, onSelect: vi.fn() }),
    );

    await act(() => press({}, 'x'));
    await act(() => press({}, 'y'));
    await act(() => press({}, 'z'));
    await act(() => press({ upArrow: true }));
    expect(result.current.selectedIndex).toBe(0);

    await act(() => press({ downArrow: true }));
    expect(result.current.selectedIndex).toBe(0);
    unmount();
  });
});

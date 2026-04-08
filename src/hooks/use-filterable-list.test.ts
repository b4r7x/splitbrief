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
  capturedHandler!(input, { ...baseKey, ...overrides });
}

beforeEach(() => {
  capturedHandler = undefined;
});

describe('useFilterableList', () => {
  it('setFilter narrows the filtered list', async () => {
    const { result, act, unmount } = renderHook(() =>
      useFilterableList({ items, filterFn, onSelect: vi.fn() }),
    );

    await act(() => result.current.setFilter('an'));
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
    const { result, act, unmount } = renderHook(() =>
      useFilterableList({ items, filterFn, onSelect }),
    );

    await act(() => result.current.setFilter('xyz'));
    await act(() => press({ return: true }));
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });
});

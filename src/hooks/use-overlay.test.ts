import { describe, it, expect } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { useOverlay } from './use-overlay.js';

describe('useOverlay', () => {
  it('starts with no active overlay', () => {
    const { result, unmount } = renderHook(() => useOverlay());
    expect(result.current.active).toBe('none');
    expect(result.current.isOpen).toBe(false);
    unmount();
  });

  it('opens an overlay', async () => {
    const { result, act, unmount } = renderHook(() => useOverlay());

    await act(() => {
      result.current.open('help');
    });

    expect(result.current.active).toBe('help');
    expect(result.current.isOpen).toBe(true);
    unmount();
  });

  it('closes an overlay', async () => {
    const { result, act, unmount } = renderHook(() => useOverlay());

    await act(() => {
      result.current.open('command-palette');
    });
    expect(result.current.isOpen).toBe(true);

    await act(() => {
      result.current.close();
    });
    expect(result.current.active).toBe('none');
    expect(result.current.isOpen).toBe(false);
    unmount();
  });

  it('switches between overlays', async () => {
    const { result, act, unmount } = renderHook(() => useOverlay());

    await act(() => {
      result.current.open('help');
    });
    expect(result.current.active).toBe('help');

    await act(() => {
      result.current.open('skills');
    });
    expect(result.current.active).toBe('skills');
    expect(result.current.isOpen).toBe(true);
    unmount();
  });

  it('returns stable function references', () => {
    const { result, unmount } = renderHook(() => useOverlay());
    expect(typeof result.current.open).toBe('function');
    expect(typeof result.current.close).toBe('function');
    unmount();
  });

  it('exclusiveInput starts false', () => {
    const { result, unmount } = renderHook(() => useOverlay());
    expect(result.current.exclusiveInput).toBe(false);
    unmount();
  });

  it('setExclusive toggles exclusiveInput', async () => {
    const { result, act, unmount } = renderHook(() => useOverlay());

    await act(() => {
      result.current.setExclusive(true);
    });
    expect(result.current.exclusiveInput).toBe(true);

    await act(() => {
      result.current.setExclusive(false);
    });
    expect(result.current.exclusiveInput).toBe(false);
    unmount();
  });

  it('close resets exclusiveInput to false', async () => {
    const { result, act, unmount } = renderHook(() => useOverlay());

    await act(() => {
      result.current.open('picker');
      result.current.setExclusive(true);
    });
    expect(result.current.exclusiveInput).toBe(true);

    await act(() => {
      result.current.close();
    });
    expect(result.current.exclusiveInput).toBe(false);
    expect(result.current.active).toBe('none');
    unmount();
  });
});

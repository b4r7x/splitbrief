import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { useGlobalKeys } from './use-global-keys.js';

describe('useGlobalKeys', () => {
  it('mounts without error on home screen', () => {
    const overlay = { isOpen: false, open: vi.fn() };
    const exit = vi.fn();
    const setErrorMessage = vi.fn();

    const { unmount } = renderHook(() =>
      useGlobalKeys({ screen: 'home', overlay, exit, setErrorMessage }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(overlay.open).not.toHaveBeenCalled();
    unmount();
  });

  it('mounts without error on workflow screen', () => {
    const overlay = { isOpen: false, open: vi.fn() };
    const exit = vi.fn();
    const setErrorMessage = vi.fn();

    const { unmount } = renderHook(() =>
      useGlobalKeys({ screen: 'workflow', overlay, exit, setErrorMessage }),
    );

    expect(exit).not.toHaveBeenCalled();
    unmount();
  });

  it('mounts without error on summary screen', () => {
    const overlay = { isOpen: false, open: vi.fn() };
    const exit = vi.fn();
    const setErrorMessage = vi.fn();

    const { unmount } = renderHook(() =>
      useGlobalKeys({ screen: 'summary', overlay, exit, setErrorMessage }),
    );

    expect(exit).not.toHaveBeenCalled();
    unmount();
  });

  it('accepts overlay in open state without error', () => {
    const overlay = { isOpen: true, open: vi.fn() };
    const exit = vi.fn();
    const setErrorMessage = vi.fn();

    const { unmount } = renderHook(() =>
      useGlobalKeys({ screen: 'home', overlay, exit, setErrorMessage }),
    );

    expect(exit).not.toHaveBeenCalled();
    unmount();
  });
});

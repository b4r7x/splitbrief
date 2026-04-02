import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { useCtrlC } from './use-ctrl-c.js';

// useCtrlC relies on useInput from ink to detect Ctrl+C keypresses.
// The current renderHook helper does not expose the stdin PassThrough,
// so we cannot simulate key events. These tests verify the hook mounts
// without error and accepts the expected arguments. Full keyboard
// interaction tests would require stdin injection support in renderHook.

describe('useCtrlC', () => {
  it('mounts without error', () => {
    const exit = vi.fn();
    const setErrorMessage = vi.fn();

    const { unmount } = renderHook(() => useCtrlC('home', exit, setErrorMessage));

    expect(exit).not.toHaveBeenCalled();
    expect(setErrorMessage).not.toHaveBeenCalled();
    unmount();
  });

  it('does not call exit or setErrorMessage on mount for workflow screen', () => {
    const exit = vi.fn();
    const setErrorMessage = vi.fn();

    const { unmount } = renderHook(() => useCtrlC('workflow', exit, setErrorMessage));

    expect(exit).not.toHaveBeenCalled();
    expect(setErrorMessage).not.toHaveBeenCalled();
    unmount();
  });

  it('mounts without error for summary screen', () => {
    const exit = vi.fn();
    const setErrorMessage = vi.fn();

    const { unmount } = renderHook(() => useCtrlC('summary', exit, setErrorMessage));

    expect(exit).not.toHaveBeenCalled();
    expect(setErrorMessage).not.toHaveBeenCalled();
    unmount();
  });
});

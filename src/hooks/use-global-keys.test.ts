import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { useGlobalKeys } from './use-global-keys.js';
import { routerStore } from '../stores/router.js';
import { overlayStore } from '../stores/overlay.js';

describe('useGlobalKeys', () => {
  beforeEach(() => {
    routerStore.reset();
    overlayStore.reset();
  });

  it('mounts without error on home screen', () => {
    const exit = vi.fn();

    const { unmount } = renderHook(() => useGlobalKeys({ exit }));

    expect(exit).not.toHaveBeenCalled();
    unmount();
  });

  it('mounts without error on workflow screen', async () => {
    routerStore.init({ screen: 'workflow', feature: 'auth' });
    const exit = vi.fn();

    const { unmount } = renderHook(() => useGlobalKeys({ exit }));

    expect(exit).not.toHaveBeenCalled();
    unmount();
  });

  it('mounts without error when overlay is open', async () => {
    overlayStore.open('help');
    const exit = vi.fn();

    const { unmount } = renderHook(() => useGlobalKeys({ exit }));

    expect(exit).not.toHaveBeenCalled();
    unmount();
  });
});

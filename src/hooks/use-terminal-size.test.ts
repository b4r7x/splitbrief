import { describe, it, expect } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { useResponsiveLayout } from './use-terminal-size.js';

describe('useResponsiveLayout', () => {
  it('returns cols, rows, and isSmall', () => {
    const { result, unmount } = renderHook(() => useResponsiveLayout());
    expect(typeof result.current.cols).toBe('number');
    expect(typeof result.current.rows).toBe('number');
    expect(typeof result.current.isSmall).toBe('boolean');
    unmount();
  });

  it('returns reasonable default dimensions', () => {
    const { result, unmount } = renderHook(() => useResponsiveLayout());
    // renderHook uses a PassThrough for stdout, which has no columns/rows,
    // so the hook falls back to 80x24 defaults
    expect(result.current.cols).toBe(80);
    expect(result.current.rows).toBe(24);
    unmount();
  });

  it('reports isSmall when cols < 120', () => {
    const { result, unmount } = renderHook(() => useResponsiveLayout());
    // Default is 80 columns, which is < 120
    expect(result.current.isSmall).toBe(true);
    unmount();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';

vi.mock('../engine/skills.js', () => ({
  discoverSkills: () => [
    { id: 'sk1', name: 'Skill One', path: '/skills/one.md' },
    { id: 'sk2', name: 'Skill Two', path: '/skills/two.md' },
  ],
}));

import { useSkills } from './use-skills.js';

describe('useSkills', () => {
  it('returns discovered skills as available', () => {
    const { result, unmount } = renderHook(() => useSkills('claude-code', '/tmp/proj'));
    expect(result.current.available).toHaveLength(2);
    expect(result.current.available[0].id).toBe('sk1');
    expect(result.current.available[1].id).toBe('sk2');
    unmount();
  });

  it('starts with no skills selected', () => {
    const { result, unmount } = renderHook(() => useSkills('claude-code', '/tmp/proj'));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.selectedMetas).toHaveLength(0);
    unmount();
  });

  it('exposes setSelected function', () => {
    const { result, unmount } = renderHook(() => useSkills('claude-code', '/tmp/proj'));
    expect(typeof result.current.setSelected).toBe('function');
    unmount();
  });

  it('updates selectedMetas when skills are selected', async () => {
    const { result, act, unmount } = renderHook(() => useSkills('claude-code', '/tmp/proj'));

    await act(() => {
      result.current.setSelected(new Set(['sk1']));
    });

    expect(result.current.selected.size).toBe(1);
    expect(result.current.selectedMetas).toHaveLength(1);
    expect(result.current.selectedMetas[0].id).toBe('sk1');
    unmount();
  });
});

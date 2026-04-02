import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';

vi.mock('../utils/sessions.js', () => ({
  getSessionDir: (scope: string, dir: string) => `${dir}/.tiny-spec/sessions`,
  listSessions: () => [
    { id: 's1', feature: 'auth', startedAt: 1000, phase: 'implementing' },
    { id: 's2', feature: 'login', startedAt: 2000, phase: 'done' },
  ],
}));

import { useSessions } from './use-sessions.js';

describe('useSessions', () => {
  it('returns sessions from the session directory', () => {
    const { result, unmount } = renderHook(() => useSessions('project', '/tmp/proj'));
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].id).toBe('s1');
    expect(result.current.sessions[1].id).toBe('s2');
    unmount();
  });

  it('returns the sessions property', () => {
    const { result, unmount } = renderHook(() => useSessions('global', '/tmp/proj'));
    expect(result.current).toHaveProperty('sessions');
    expect(Array.isArray(result.current.sessions)).toBe(true);
    unmount();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sessionsStore } from './sessions.js';

vi.mock('../utils/sessions.js', () => ({
  getSessionDir: vi.fn(() => '/tmp/sessions'),
  listSessions: vi.fn(() => [
    { id: 's1', feature: 'auth', startedAt: 1000, completedAt: 2000, status: 'complete', summary: null, stateVersion: 1, stateFile: null },
  ]),
}));

describe('sessionsStore', () => {
  beforeEach(() => sessionsStore.reset());

  it('starts empty', () => {
    expect(sessionsStore.get().sessions).toHaveLength(0);
  });

  it('loads sessions from disk', () => {
    sessionsStore.load('project', '/tmp/proj');
    expect(sessionsStore.get().sessions).toHaveLength(1);
    expect(sessionsStore.get().sessions[0].id).toBe('s1');
  });
});

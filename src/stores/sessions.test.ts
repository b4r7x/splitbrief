import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../types.js';
import { makeSession } from '#testing/helpers/fixtures.js';

const listSessionsMock = vi.fn<(projectDir: string) => Session[]>();
const listAllSessionsMock = vi.fn<(projectDir: string) => Session[]>();

vi.mock('../core/sessions/io.js', () => ({
  listSessions: (projectDir: string) => listSessionsMock(projectDir),
  listAllSessions: (projectDir: string) => listAllSessionsMock(projectDir),
}));

const { sessionsStore } = await import('./sessions.js');

describe('sessionsStore', () => {
  beforeEach(() => {
    listSessionsMock.mockReset();
    listAllSessionsMock.mockReset();
    sessionsStore.reset();
  });

  it('starts with an empty sessions list', () => {
    expect(sessionsStore.get().sessions).toEqual([]);
  });

  it('load() populates sessions from the project directory', () => {
    const sessions = [makeSession({ id: 'a' }), makeSession({ id: 'b' })];
    listSessionsMock.mockReturnValue(sessions);

    sessionsStore.load('/tmp/project');

    expect(listSessionsMock).toHaveBeenCalledWith('/tmp/project');
    expect(sessionsStore.get().sessions).toBe(sessions);
  });

  it('load() with empty result sets empty sessions', () => {
    listSessionsMock.mockReturnValue([]);

    sessionsStore.load('/tmp/project');

    expect(sessionsStore.get().sessions).toEqual([]);
  });

  it('reset() returns the store to the empty initial state', () => {
    listSessionsMock.mockReturnValue([makeSession()]);
    sessionsStore.load('/tmp/project');
    expect(sessionsStore.get().sessions).toHaveLength(1);

    sessionsStore.reset();
    expect(sessionsStore.get().sessions).toEqual([]);
  });

  describe('loadAll', () => {
    it('populates allSessions from the project directory', () => {
      const sessions = [makeSession({ id: 'x' }), makeSession({ id: 'y' }), makeSession({ id: 'z' })];
      listAllSessionsMock.mockReturnValue(sessions);

      sessionsStore.loadAll('/tmp/project');

      expect(listAllSessionsMock).toHaveBeenCalledWith('/tmp/project');
      expect(sessionsStore.get().allSessions).toBe(sessions);
    });

    it('starts with empty allSessions', () => {
      expect(sessionsStore.get().allSessions).toEqual([]);
    });
  });
});

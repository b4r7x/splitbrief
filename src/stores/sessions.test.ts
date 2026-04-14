import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../types.js';

const listSessionsMock = vi.fn<(dir: string) => Session[]>();
const getSessionDirMock = vi.fn<(scope: 'project' | 'global', projectDir: string) => string>();

vi.mock('../core/sessions/io.js', () => ({
  listSessions: (dir: string) => listSessionsMock(dir),
  getSessionDir: (scope: 'project' | 'global', projectDir: string) => getSessionDirMock(scope, projectDir),
}));

const { sessionsStore } = await import('./sessions.js');

const makeSession = (overrides?: Partial<Session>): Session => ({
  id: 'sess-1',
  feature: 'example',
  startedAt: 1_700_000_000,
  completedAt: null,
  stateVersion: 1,
  stateFile: null,
  status: 'interrupted',
  summary: null,
  ...overrides,
} as Session);

describe('sessionsStore', () => {
  beforeEach(() => {
    listSessionsMock.mockReset();
    getSessionDirMock.mockReset();
    sessionsStore.reset();
  });

  it('starts with an empty sessions list', () => {
    expect(sessionsStore.get().sessions).toEqual([]);
  });

  it('load() populates sessions from the resolved directory', () => {
    const sessions = [makeSession({ id: 'a' }), makeSession({ id: 'b' })];
    getSessionDirMock.mockReturnValue('/tmp/project/.diptych/sessions');
    listSessionsMock.mockReturnValue(sessions);

    sessionsStore.load('project', '/tmp/project');

    expect(getSessionDirMock).toHaveBeenCalledWith('project', '/tmp/project');
    expect(listSessionsMock).toHaveBeenCalledWith('/tmp/project/.diptych/sessions');
    expect(sessionsStore.get().sessions).toBe(sessions);
  });

  it('load() with scope=global resolves the global directory', () => {
    getSessionDirMock.mockReturnValue('/home/u/.diptych/sessions');
    listSessionsMock.mockReturnValue([]);

    sessionsStore.load('global', '/unused');

    expect(getSessionDirMock).toHaveBeenCalledWith('global', '/unused');
    expect(sessionsStore.get().sessions).toEqual([]);
  });

  it('reset() returns the store to the empty initial state', () => {
    getSessionDirMock.mockReturnValue('/tmp');
    listSessionsMock.mockReturnValue([makeSession()]);
    sessionsStore.load('project', '/tmp');
    expect(sessionsStore.get().sessions).toHaveLength(1);

    sessionsStore.reset();
    expect(sessionsStore.get().sessions).toEqual([]);
  });
});

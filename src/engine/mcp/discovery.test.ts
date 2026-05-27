import { describe, it, expect, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { writeActive } from '../../core/sessions/lifecycle.js';
import { saveSummary } from '../../core/sessions/io.js';
import { resolveSessionIds } from './discovery.js';

const SESSION_STUB = {
  id: '',
  feature: 'test feature',
  startedAt: Date.now(),
  completedAt: null,
  stateVersion: 1,
  stateFile: null,
  status: 'interrupted' as const,
  summary: null,
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('resolveSessionIds', () => {
  it('returns [session] when --session points to an existing directory', () => {
    const projectDir = createTempDir('discovery-test'); dirs.push(projectDir);
    ensureSessionDir(projectDir, 'abc');
    expect(resolveSessionIds(projectDir, { session: 'abc' })).toEqual(['abc']);
  });

  it('throws "Session not found" when --session directory does not exist', () => {
    const projectDir = createTempDir('discovery-test'); dirs.push(projectDir);
    expect(() => resolveSessionIds(projectDir, { session: 'missing' })).toThrow('Session not found: missing');
  });

  it('returns all session IDs when --all-sessions is set', () => {
    const projectDir = createTempDir('discovery-test'); dirs.push(projectDir);
    saveSummary({ projectDir: projectDir, sessionId: 'sess-1' }, { ...SESSION_STUB, id: 'sess-1' });
    saveSummary({ projectDir: projectDir, sessionId: 'sess-2' }, { ...SESSION_STUB, id: 'sess-2' });
    const ids = resolveSessionIds(projectDir, { allSessions: true });
    expect(ids).toHaveLength(2);
    expect(ids).toContain('sess-1');
    expect(ids).toContain('sess-2');
  });

  it('throws when --all-sessions is set but no sessions exist', () => {
    const projectDir = createTempDir('discovery-test'); dirs.push(projectDir);
    expect(() => resolveSessionIds(projectDir, { allSessions: true })).toThrow(
      'No sessions found in this project.',
    );
  });

  it('returns [activeId] when neither option is set and active session exists', () => {
    const projectDir = createTempDir('discovery-test'); dirs.push(projectDir);
    ensureSessionDir(projectDir, 'active-sess');
    writeActive({ projectDir: projectDir, sessionId: 'active-sess' });
    expect(resolveSessionIds(projectDir, {})).toEqual(['active-sess']);
  });

  it('throws when neither option is set and no active session exists', () => {
    const projectDir = createTempDir('discovery-test'); dirs.push(projectDir);
    expect(() => resolveSessionIds(projectDir, {})).toThrow(
      'No active session. Use --session <id> or --all-sessions.',
    );
  });
});

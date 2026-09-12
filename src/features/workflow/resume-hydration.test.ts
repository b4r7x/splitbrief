import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../core/paths-io.js';
import { STATE_FILE, sessionDir } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { hydrateResume, resumeFailureMessage } from './resume-hydration.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('resume-hydration-test');
  createTestGitRepo(projectDir);
  ensureSplitbriefDir(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('hydrateResume', () => {
  it('reports missing when the session has no saved state', () => {
    const ref = { projectDir, sessionId: '2026-09-01-no-state' };
    ensureSessionDir(projectDir, ref.sessionId);

    expect(hydrateResume(ref)).toEqual({ kind: 'missing' });
  });

  it('loads the saved state through the owner loader', () => {
    const ref = { projectDir, sessionId: '2026-09-01-loaded' };
    ensureSessionDir(projectDir, ref.sessionId);
    const saved = { ...createInitialState('add auth'), phase: 'reviewing-spec' as const };
    saveState(ref, saved);

    const hydrated = hydrateResume(ref);

    expect(hydrated.kind).toBe('loaded');
    if (hydrated.kind !== 'loaded') throw new Error('unreachable');
    expect(hydrated.state.phase).toBe('reviewing-spec');
  });

  it('classifies a state file written by a newer version as invalid', () => {
    const ref = { projectDir, sessionId: '2026-09-01-future' };
    ensureSessionDir(projectDir, ref.sessionId);
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeFileSync(
      join(sessionDir(projectDir, ref.sessionId), STATE_FILE),
      JSON.stringify({ stateVersion: 99 }),
    );

    const hydrated = hydrateResume(ref);
    warn.mockRestore();

    expect(hydrated).toMatchObject({ kind: 'invalid', code: 'future-version' });
  });

  it('classifies an unparseable state file as invalid rather than missing', () => {
    const ref = { projectDir, sessionId: '2026-09-01-corrupt' };
    ensureSessionDir(projectDir, ref.sessionId);
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeFileSync(join(sessionDir(projectDir, ref.sessionId), STATE_FILE), '{ not json');

    const hydrated = hydrateResume(ref);
    warn.mockRestore();

    expect(hydrated).toMatchObject({ kind: 'invalid', code: 'malformed' });
  });
});

describe('resumeFailureMessage', () => {
  it('prefixes the underlying reason', () => {
    expect(resumeFailureMessage({ kind: 'invalid', code: 'malformed', message: 'bad json' })).toBe(
      'Cannot resume: bad json',
    );
  });
});

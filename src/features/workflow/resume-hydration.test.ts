import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { acquireStateAuthority, releaseStateAuthority } from '../../core/state/authority.js';
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

    expect(hydrateResume(ref, undefined)).toEqual({ kind: 'missing' });
  });

  it('loads the saved state under a supplied fenced receipt', () => {
    const ref = { projectDir, sessionId: '2026-09-01-loaded' };
    ensureSessionDir(projectDir, ref.sessionId);
    const saved = { ...createInitialState('add auth'), phase: 'reviewing-spec' as const };
    saveState(ref, saved);
    const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
    if (acquired.kind !== 'fenced') throw new Error('expected a fenced authority');

    const hydrated = hydrateResume(ref, acquired.receipt);

    expect(hydrated.kind).toBe('loaded');
    if (hydrated.kind !== 'loaded') throw new Error('unreachable');
    expect(hydrated.state.phase).toBe('reviewing-spec');
    expect(hydrated.authority).toEqual(acquired.receipt);

    releaseStateAuthority(ref, acquired.receipt);
  });
});

describe('resumeFailureMessage', () => {
  it('prefixes the underlying reason', () => {
    expect(resumeFailureMessage({ kind: 'invalid', code: 'malformed', message: 'bad json' })).toBe(
      'Cannot resume: bad json',
    );
  });
});

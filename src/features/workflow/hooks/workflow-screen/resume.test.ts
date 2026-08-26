import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../../core/paths-io.js';
import { STATE_FILE } from '../../../../core/paths.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { acquireStateAuthority, releaseStateAuthority } from '../../../../core/state/authority.js';
import { loadState, saveState } from '../../../../core/state/persistence.js';
import type { BriefRecoveryV1 } from '../../../../core/schemas/brief-recovery/document.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import {
  canResumeCancelledWorkflow,
  hasLoadedResumableStateForSession,
  loadWorkflowScreenResume,
} from './resume.js';

const projects: string[] = [];

afterEach(() => {
  for (const projectDir of projects.splice(0)) cleanupTempDir(projectDir);
});

function fixture(sessionId = 'screen-resume'): {
  projectDir: string;
  ref: { projectDir: string; sessionId: string };
} {
  const projectDir = createTempDir('workflow-screen-resume');
  projects.push(projectDir);
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, ref: { projectDir, sessionId } };
}

function resumableState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    ...createInitialState('resume feature'),
    phase: 'planning',
    ...overrides,
  };
}

function storageBlockedRecovery(): BriefRecoveryV1 {
  return {
    version: 1,
    recoveryRevision: 1,
    epochId: 'epoch-1',
    origin: { mode: 'quick', entry: 'initial' },
    continuation: { version: 1, kind: 'quick-start', entry: 'initial' },
    status: 'storage-blocked',
    activeBrief: null,
    storageEvidence: { code: 'brief_storage_invalid', artifactRef: 'tasks.md' },
    evidenceHead: 'e'.repeat(64),
    outbox: [],
  };
}

describe('workflow-screen resumability', () => {
  it('loads a current v4 resumable state through the injected owner receipt', () => {
    const { ref } = fixture();
    saveState(ref, resumableState());
    const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
    if (acquired.kind !== 'fenced') throw new Error('expected fenced authority');

    const result = loadWorkflowScreenResume({
      ...ref,
      authority: acquired.receipt,
    });

    expect(result.kind).toBe('resumable');
    expect(hasLoadedResumableStateForSession({ ...ref, authority: acquired.receipt })).toBe(true);
    expect(releaseStateAuthority(ref, acquired.receipt)).toBe(true);
  });

  it('keeps a migrated/storage-blocked review visible and resumable', () => {
    const { ref } = fixture('storage-blocked');
    saveState(
      ref,
      resumableState({
        phase: 'reviewing-briefs',
        briefRecovery: storageBlockedRecovery(),
      }),
    );
    const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
    if (acquired.kind !== 'fenced') throw new Error('expected fenced authority');

    const result = loadWorkflowScreenResume({ ...ref, authority: acquired.receipt });

    expect(result.kind).toBe('storage-blocked');
    expect(hasLoadedResumableStateForSession({ ...ref, authority: acquired.receipt })).toBe(true);
    expect(releaseStateAuthority(ref, acquired.receipt)).toBe(true);
  });

  it('returns a typed future-version refusal without rewriting the state bytes', () => {
    const { projectDir, ref } = fixture('future-state');
    const path = join(projectDir, '.splitbrief', 'sessions', ref.sessionId, STATE_FILE);
    const raw = '{"stateVersion":99,"future":true}\n';
    writeFileSync(path, raw, { mode: 0o600 });
    const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
    if (acquired.kind !== 'read-only') throw new Error('expected read-only authority');

    const result = loadWorkflowScreenResume({ ...ref, authority: acquired });

    expect(result).toMatchObject({ kind: 'invalid', code: 'future-version' });
    expect(loadState(ref)).toBeNull();
  });

  it('uses the authenticated owner route before attempting local hydration', () => {
    const { projectDir, ref } = fixture('owner-route');
    const routeState = resumableState();

    const result = loadWorkflowScreenResume({
      ...ref,
      routeSessionId: ref.sessionId,
      routeResumeState: routeState,
    });

    expect(result).toEqual({ kind: 'resumable', state: routeState });
    expect(
      canResumeCancelledWorkflow({
        isAttachedClient: false,
        cancelled: true,
        projectDir,
        sessionId: ref.sessionId,
        runnerSessionId: undefined,
        routeSessionId: ref.sessionId,
        routeResumeState: routeState,
      }),
    ).toBe(true);
  });

  it('does not resume terminal or other-phase state', () => {
    const { ref } = fixture('terminal-state');
    const terminal = loadWorkflowScreenResume({
      ...ref,
      routeSessionId: ref.sessionId,
      routeResumeState: { ...createInitialState('done'), phase: 'idle' },
    });
    const other = loadWorkflowScreenResume({
      ...ref,
      routeSessionId: ref.sessionId,
      routeResumeState: { ...createInitialState('other phase'), phase: 'clarifying' },
    });

    expect(terminal).toEqual({ kind: 'not-resumable', reason: 'terminal' });
    expect(other).toEqual({ kind: 'not-resumable', reason: 'other-phase' });
  });
});

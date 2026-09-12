import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../../core/paths-io.js';
import { STATE_FILE } from '../../../../core/paths.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { saveState } from '../../../../core/state/persistence.js';
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

describe('workflow-screen resumability', () => {
  it('loads a saved resumable state from the session directory', () => {
    const { ref } = fixture();
    saveState(ref, resumableState());

    const result = loadWorkflowScreenResume(ref);

    expect(result).toMatchObject({
      kind: 'resumable',
      state: { feature: 'resume feature', phase: 'planning' },
    });
    expect(hasLoadedResumableStateForSession(ref)).toBe(true);
  });

  it('reports a missing workflow state when the session has none saved', () => {
    const { ref } = fixture('no-state');

    expect(loadWorkflowScreenResume(ref)).toEqual({ kind: 'not-resumable', reason: 'missing' });
  });

  it('names a future state version instead of reporting it as missing', () => {
    const { projectDir, ref } = fixture('future-state');
    writeFileSync(
      join(projectDir, '.splitbrief', 'sessions', ref.sessionId, STATE_FILE),
      JSON.stringify({ ...resumableState(), stateVersion: 99 }),
      { mode: 0o600 },
    );

    expect(loadWorkflowScreenResume(ref)).toMatchObject({
      kind: 'invalid',
      code: 'future-version',
    });
  });

  it('reports invalid when the state directory escapes the project root', () => {
    const { projectDir, ref } = fixture('escaped-state');
    const outside = createTempDir('workflow-screen-resume-outside');
    projects.push(outside);
    writeFileSync(join(outside, STATE_FILE), JSON.stringify(resumableState()), { mode: 0o600 });
    const sessionDir = join(projectDir, '.splitbrief', 'sessions', ref.sessionId);
    rmSync(sessionDir, { recursive: true, force: true });
    symlinkSync(outside, sessionDir);

    expect(loadWorkflowScreenResume(ref)).toMatchObject({ kind: 'invalid', code: 'malformed' });
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

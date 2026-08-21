import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { assertResumableState } from '../../sessions/resolve.js';
import { resumeSavedSession } from './resume.js';

function resumableState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    ...createInitialState('migration feature'),
    phase: 'planning',
    ...overrides,
  };
}

describe('resume migration boundary', () => {
  it('accepts only current v4 resumable phases', () => {
    const state = resumableState();

    expect(() => assertResumableState(state, 'session-1')).not.toThrow();
    expect(() => assertResumableState({ ...state, stateVersion: 3 }, 'session-1')).toThrow(
      /not current v4 and cannot be resumed/,
    );
    expect(() => assertResumableState({ ...state, phase: 'idle' }, 'session-1')).toThrow(
      /cannot be resumed/,
    );
  });

  it('retains recovery identity fields without deriving them from artifacts', () => {
    const recovery = {
      epochId: 'epoch-1',
      origin: { mode: 'standard', entry: 'initial' },
      continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
      operationId: 'operation-1',
    };
    const state = resumableState({
      phase: 'reviewing-briefs',
      external: { recovery },
    });

    assertResumableState(state, 'session-1');

    expect(state.external).toEqual({ recovery });
    expect(state.external?.recovery).toBe(recovery);
  });

  it('rejects an unmigrated v3 state before loading config or calling a provider', async () => {
    const prepareExecution = vi.fn();

    await expect(
      resumeSavedSession({
        projectDir: '/tmp/resume-migration-boundary',
        sessionId: 'session-1',
        state: { ...resumableState(), stateVersion: 3 },
        opts: {},
        deps: {
          prepareExecution,
          initStores: async () => {},
          renderApp: async () => {},
          runHeadless: async () => {},
          runRpc: async () => {},
          setupWorkflow: async () => ({
            projectDir: '/tmp/resume-migration-boundary',
            useFullscreen: false,
            useMouse: false,
            useHover: false,
          }),
        },
      }),
    ).rejects.toThrow(/not current v4 and cannot be resumed/);

    expect(prepareExecution).not.toHaveBeenCalled();
  });
});

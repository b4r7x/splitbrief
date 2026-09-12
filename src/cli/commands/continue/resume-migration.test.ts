import { describe, expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
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

  it('carries recovery identity fields into preparation instead of deriving them from artifacts', async () => {
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

    expect(() => assertResumableState(state, 'session-1')).not.toThrow();

    const prepareExecution = vi.fn(
      async (_input: PrepareExecutionInput) => ({ kind: 'aborted' }) as const,
    );

    await withTempDir('resume-migration-recovery', async (projectDir) => {
      await expect(
        resumeSavedSession({
          projectDir,
          sessionId: 'session-1',
          state,
          opts: {},
          deps: {
            prepareExecution,
            initStores: async () => {},
            renderApp: async () => {},
            runHeadless: async () => {},
            setupWorkflow: async () => ({
              projectDir,
              useFullscreen: false,
              useMouse: false,
              useHover: false,
            }),
          },
        }),
      ).rejects.toThrow(/cancelled/);
    });

    expect(prepareExecution.mock.calls[0]?.[0]).toMatchObject({
      resumeState: { external: { recovery } },
    });
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

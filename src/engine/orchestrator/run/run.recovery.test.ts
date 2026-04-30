import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readActive, writeActive } from '../../../core/sessions/lifecycle.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { buildValidationFailedRecoveryIssue } from '../recovery/recovery.js';
import { runWorkflow } from './run.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function implementingState(tasks: Task[]): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'APPROVE_PLAN' });
  return {
    ...state,
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
  };
}

describe('runWorkflow recovery resume', () => {
  it('preserves the active session when a saved pending recovery stops before planner availability checks', async () => {
    const projectDir = createTempDir('run-recovery');
    dirs.push(projectDir);
    const sessionId = 'sess-run-recovery';
    ensureSessionDir(projectDir, sessionId);
    writeActive(projectDir, sessionId);

    const task = makeTask({ id: 'T001' });
    const issue = buildValidationFailedRecoveryIssue({
      task,
      validationSummary: 'tsc failed',
      attempts: 1,
      maxAttempts: 2,
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    const savedState = transition(implementingState([task]), { type: 'SET_PENDING_RECOVERY', issue });
    saveState(projectDir, sessionId, savedState);

    const { callbacks } = makeCallbacks();
    const isAvailable = vi.fn().mockResolvedValue(false);

    await runWorkflow({
      feature: 'feat',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { autoApproveSpec: true, autoApprovePlan: true, commitStrategy: 'none', mode: 'quick', persistTranscript: false },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      savedState,
      sessionId,
      _planner: makePlanner({ isAvailable }),
    });

    expect(isAvailable).not.toHaveBeenCalled();
    expect(readActive(projectDir)).toBe(sessionId);
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toMatchObject({
      reason: 'validation-failed',
      taskId: 'T001',
    });
  });
});

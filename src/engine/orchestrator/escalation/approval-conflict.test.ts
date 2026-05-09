import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks, makePlanner, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { handleApprovalTimeUserEditConflict } from './approval-conflict.js';
import type { WorkflowContext } from '../types.js';

const dirs: string[] = [];

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('approval-conflict-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-approval-conflict';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('handleApprovalTimeUserEditConflict', () => {
  it('transitions state to pending recovery, publishes events, and updates tracked state', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = makeNoValidationConfig();
    const { bus, events } = makeBusRecorder();
    const state = makeImplState([]);
    const task = makeTask({ id: 'T001', file: 'src/test.ts' });
    const { callbacks } = makeCallbacks();
    const trackedStates: typeof state[] = [];
    const ctx: WorkflowContext = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir, runtime: 'node', testCommand: 'npm test' },
      implementer: makeImplementer(),
      metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      validator: { findAffectedTestFile: () => null, runValidation: async () => [] },
    };

    const nextState = await handleApprovalTimeUserEditConflict({
      ctx,
      state,
      task,
      files: ['src/test.ts'],
      setTrackedState: next => trackedStates.push(next),
    });

    expect(nextState.pendingRecovery).toBeDefined();
    expect(trackedStates).toEqual([nextState]);
    expect(events.some(e => e.type === 'paused_external_changes')).toBe(true);
    expect(events.some(e => e.type === 'recovery_prompted')).toBe(true);
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toBeDefined();
  });
});

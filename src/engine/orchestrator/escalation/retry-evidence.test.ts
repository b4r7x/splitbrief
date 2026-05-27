import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks, makePlanner, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { createValidator } from '../validation.js';
import { persistRetryApprovalEvidence, persistRetryRejectionEvidence } from './retry-evidence.js';
import { readEvidenceLedger } from '../evidence/persistence.js';
import type { EscalationContext } from './types.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' } as const;

const TEST_SINKS = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

const dirs: string[] = [];

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('retry-evidence-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-retry-evidence';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('persistRetryApprovalEvidence', () => {
  it('writes approval evidence to ledger', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = makeNoValidationConfig();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir, runtime: 'node', testCommand: 'npm test' },
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot,
      dependsOnFiles: [] as string[],
    };
    const state = makeImplState([]);
    const task = makeTask({ id: 'T001', file: 'src/test.ts' });
    const decision = {
      allow: true,
      changedFiles: ['src/test.ts'],
      confirmApprovals: [{ tier: 'confirm' as const, actionClass: 'write_in_scope' as const, actionDescription: 'edit file', reason: 'approved' }],
    };

    persistRetryApprovalEvidence(ctx, state, task, decision);

    const ledger = readEvidenceLedger(projectDir, sessionId);
    expect(ledger?.approvals?.length).toBe(1);
    expect(ledger?.approvals?.[0]).toMatchObject({
      taskId: 'T001',
      actionClass: 'write_in_scope',
    });
  });

  it('does nothing when no confirmApprovals', () => {
    const { projectDir, sessionId } = setupProject();
    const { bus } = makeBusRecorder();
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir, runtime: 'node', testCommand: 'npm test' },
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot: { head: 'abc', files: [], dirtyFileContents: {} },
      dependsOnFiles: [] as string[],
    };
    const state = makeImplState([]);
    const task = makeTask({ id: 'T001', file: 'src/test.ts' });
    const decision = { allow: true, changedFiles: [] };

    persistRetryApprovalEvidence(ctx, state, task, decision);

    expect(readEvidenceLedger(projectDir, sessionId)).toBeNull();
  });
});

describe('persistRetryRejectionEvidence', () => {
  it('writes rejection evidence to ledger', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = makeNoValidationConfig();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir, runtime: 'node', testCommand: 'npm test' },
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot,
      dependsOnFiles: [] as string[],
    };
    const state = makeImplState([]);
    const task = makeTask({ id: 'T002', file: 'src/test.ts' });
    const decision = {
      allow: false,
      changedFiles: ['src/test.ts'],
      tier: 'confirm' as const,
      actionClass: 'write_in_scope' as const,
      actionDescription: 'edit file',
      reason: 'denied',
    };

    persistRetryRejectionEvidence(ctx, state, task, decision);

    const ledger = readEvidenceLedger(projectDir, sessionId);
    expect(ledger?.rejections?.length).toBe(1);
    expect(ledger?.rejections?.[0]).toMatchObject({
      taskId: 'T002',
      actionClass: 'write_in_scope',
    });
  });

  it('does nothing for auto tier', () => {
    const { projectDir, sessionId } = setupProject();
    const { bus } = makeBusRecorder();
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config: makeNoValidationConfig(),
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir, runtime: 'node', testCommand: 'npm test' },
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot: { head: 'abc', files: [], dirtyFileContents: {} },
      dependsOnFiles: [] as string[],
    };
    const state = makeImplState([]);
    const task = makeTask({ id: 'T003', file: 'src/test.ts' });
    const decision = { allow: false, changedFiles: [], tier: 'auto' as const };

    persistRetryRejectionEvidence(ctx, state, task, decision);

    expect(readEvidenceLedger(projectDir, sessionId)).toBeNull();
  });
});

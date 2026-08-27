import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makePlanner,
  makeImplementer,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createValidator } from '../validation/run.js';
import { persistRetryApprovalEvidence, persistRetryRejectionEvidence } from './retry-evidence.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EscalationContext } from './types.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('retry-evidence-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-retry-evidence';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

async function makeRetryEvidenceCtx(
  snapshot?: ChangedFilesSnapshot,
): Promise<{ ctx: EscalationContext; projectDir: string; sessionId: string }> {
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
    reviewer: makePlanner(),
    context: { name: 'test', dir: projectDir },
    implementer: makeImplementer(),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
    isolation: makeCopyingIsolation({ projectDir: projectDir, sessionId }),
    taskStartSnapshot: snapshot ?? (await getChangedFilesSnapshot(projectDir)),
    dependsOnFiles: [] as string[],
  };
  return { ctx, projectDir, sessionId };
}

describe('persistRetryApprovalEvidence', () => {
  it('writes approval evidence to ledger', async () => {
    const { ctx, projectDir, sessionId } = await makeRetryEvidenceCtx();
    const state = makeImplState([]);
    const task = makeTask({ id: 'T001', file: 'src/test.ts' });
    const decision = {
      allow: true,
      changedFiles: ['src/test.ts'],
      confirmApprovals: [
        {
          tier: 'confirm' as const,
          actionClass: 'write_in_scope' as const,
          actionDescription: 'edit file',
          reason: 'approved',
        },
      ],
    };

    persistRetryApprovalEvidence(ctx, state, task, decision);

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.approvals?.length).toBe(1);
    expect(ledger?.approvals?.[0]).toMatchObject({
      taskId: 'T001',
      actionClass: 'write_in_scope',
    });
  });

  it('does nothing when no confirmApprovals', async () => {
    const { ctx, projectDir, sessionId } = await makeRetryEvidenceCtx({
      head: 'abc',
      files: [],
      dirtyFileContents: {},
    });
    const state = makeImplState([]);
    const task = makeTask({ id: 'T001', file: 'src/test.ts' });
    const decision = { allow: true, changedFiles: [] };

    persistRetryApprovalEvidence(ctx, state, task, decision);

    expect(readEvidenceLedger({ projectDir, sessionId })).toBeNull();
  });
});

describe('persistRetryRejectionEvidence', () => {
  it('writes rejection evidence to ledger', async () => {
    const { ctx, projectDir, sessionId } = await makeRetryEvidenceCtx();
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

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.rejections?.length).toBe(1);
    expect(ledger?.rejections?.[0]).toMatchObject({
      taskId: 'T002',
      actionClass: 'write_in_scope',
    });
  });

  it('does nothing for auto tier', async () => {
    const { ctx, projectDir, sessionId } = await makeRetryEvidenceCtx({
      head: 'abc',
      files: [],
      dirtyFileContents: {},
    });
    const state = makeImplState([]);
    const task = makeTask({ id: 'T003', file: 'src/test.ts' });
    const decision = { allow: false, changedFiles: [], tier: 'auto' as const };

    persistRetryRejectionEvidence(ctx, state, task, decision);

    expect(readEvidenceLedger({ projectDir, sessionId })).toBeNull();
  });
});

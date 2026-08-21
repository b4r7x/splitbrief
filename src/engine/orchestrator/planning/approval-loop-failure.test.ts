import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import {
  TEST_METADATA,
  makePassingPlanner,
  setupProject,
} from '#testing/helpers/planning-phase.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function recoveryProjection(sessionId: string): BriefRecoveryProjectionV1 {
  const brief = { revision: 0, hash: 'brief-hash', path: 'tasks.md' };
  return {
    version: 1,
    sessionId,
    stateRevision: 0,
    recoveryRevision: 0,
    epochId: 'epoch-1',
    status: 'blocked',
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: brief,
    matchingReport: {
      briefHash: brief.hash,
      report: { revision: 0, hash: 'report-hash', path: 'brief-quality.json' },
      ruleVersion: 'brief-quality-v1',
      issues: [],
    },
    blocker: null,
    allowedActions: ['approve', 'reject'],
    activeOperation: null,
    latestAttempt: null,
    queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
  };
}

describe('runBriefsApprovalLoop failure boundaries', () => {
  it('fails closed when the recovery controller throws instead of prompting forever', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const dispatchBriefAction = vi.fn().mockRejectedValue(new Error('storage unavailable'));

    const result = await runBriefsApprovalLoop({
      tasks: [],
      planner: makePassingPlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-briefs' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
      recovery: {
        controller: { dispatchBriefAction, queueBriefInput: vi.fn() },
        authority: {
          kind: 'usable',
          sessionId,
          ownerId: 'test-owner',
          pid: process.pid,
          processStart: 'test-process',
          runId: 'test-run',
          acquisitionId: 'test-acquisition',
          fence: 1,
          stateRevision: 0,
          stateDigest: 'test-state-digest',
        },
        projection: recoveryProjection(sessionId),
      },
    });

    expect(result).toMatchObject({ rejected: false, outcome: 'failed' });
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(dispatchBriefAction).toHaveBeenCalledTimes(1);
  });
});

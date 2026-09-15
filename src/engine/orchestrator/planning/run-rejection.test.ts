import { describe, it, expect, afterEach } from 'vitest';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { runPlanningPhase } from './run.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Planner } from '../../planners/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import {
  TEST_METADATA,
  setupProject,
  makeRecordingPlanner,
  seedRejectionEvidence,
  sequencedApproval,
  manual,
  runPlanningTurn as runPhaseHelper,
  type RunOpts,
} from '#testing/helpers/planning-phase.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runPhase(opts: RunOpts = {}) {
  return runPhaseHelper(dirs, opts);
}

describe('runPlanningPhase — planner rejection context', () => {
  const feature = 'implement audited API sync';
  const rejectionSummary =
    '[sticky] network: fetch https://api.example.com/audit (reason: user denied network access)';

  async function runSeededPlanning(opts: {
    workflow: Partial<Config['workflow']>;
    planner: Planner;
    approval?: Config['approval'] | undefined;
  }) {
    const { projectDir, sessionId } = setupProject(dirs);
    seedRejectionEvidence(projectDir, sessionId);
    const config = makeConfig({
      workflow: { approve: 'none', ...opts.workflow },
      ...(opts.approval ? { approval: opts.approval } : {}),
    });
    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks: makeCallbacks().callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner: opts.planner,
      state: transition(createInitialState(feature), { type: 'START' }),
      feature,
    });
    return result;
  }

  it('prepends prior rejection context to standard planner input by default', async () => {
    const { planner, calls } = makeRecordingPlanner();

    const result = await runSeededPlanning({
      workflow: { mode: 'standard' },
      planner,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(calls[0]?.inputs.promptPrefix).toContain('Previous rejections:');
    expect(calls[0]?.inputs.promptPrefix).toContain(rejectionSummary);
    expect(calls[0]?.inputs.feature).toContain(feature);
  });

  it('prepends prior rejection context to quick planner input when enabled', async () => {
    const { planner, calls } = makeRecordingPlanner();

    const result = await runSeededPlanning({
      workflow: { mode: 'quick' },
      planner,
      approval: { enabled: true, feedRejectionsToPlanner: true },
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(calls[0]?.inputs.promptPrefix).toContain('Previous rejections:');
    expect(calls[0]?.inputs.promptPrefix).toContain(rejectionSummary);
    expect(calls[0]?.inputs.feature).toContain(feature);
  });

  it('does not include prior rejection context when feedRejectionsToPlanner is false', async () => {
    const { planner, calls } = makeRecordingPlanner();

    const result = await runSeededPlanning({
      workflow: { mode: 'standard' },
      planner,
      approval: { enabled: true, feedRejectionsToPlanner: false },
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(calls[0]?.inputs.promptPrefix).toBeUndefined();
    expect(calls[0]?.inputs.feature).toContain(feature);
  });
});

describe('runPlanningPhase — end-run paths', () => {
  const endRunCases: Array<{
    name: string;
    workflow: Partial<Config['workflow']>;
    approvals: readonly ApprovalReviewResult[];
    expectPhase?: WorkflowState['phase'];
  }> = [
    {
      name: 'user ends the run at the spec gate → closed, phase unchanged',
      workflow: manual(),
      approvals: [{ approved: false, action: 'end-run' }],
      expectPhase: 'reviewing-spec',
    },
    {
      name: 'user ends the run at the plan gate (speckit mode) → closed',
      workflow: manual('speckit'),
      approvals: [{ approved: true }, { approved: false, action: 'end-run' }],
    },
  ] as const;

  it.each(endRunCases)('$name', async ({ workflow, approvals, expectPhase }) => {
    const { callbacks } = makeCallbacks({ onApprovalNeeded: sequencedApproval(approvals) });
    const { result } = await runPhase({ callbacks, config: makeConfig({ workflow }) });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'closed' });
    expect(result.state.closed).toEqual({ at: expect.any(String), as: 'ended' });
    if (expectPhase !== undefined) {
      expect(result.state.phase).toBe(expectPhase);
    }
  });
});

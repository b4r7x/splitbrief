import { describe, it, expect, afterEach } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
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
  makePassingTask,
  makePassingPlanner,
  seedRejectionEvidence,
  sequencedApproval,
  manual,
  runPhase as runPhaseHelper,
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
      state: { ...createInitialState(feature), phase: 'idle' },
      feature,
    });
    return result;
  }

  it('prepends prior rejection context to standard planner input by default', async () => {
    const prompts: string[] = [];
    const plan: Planner['plan'] = async (opts) => {
      prompts.push(opts.feature);
      return makePassingPlanner().plan(opts);
    };
    const planner = makePassingPlanner({ plan });

    const result = await runSeededPlanning({
      workflow: { mode: 'standard' },
      planner,
    });

    expect(result.cancelled).toBe(false);
    expect(prompts).toEqual([expect.stringContaining('Previous rejections:')]);
    expect(prompts[0]).toContain(rejectionSummary);
    expect(prompts[0]).toContain(feature);
  });

  it('prepends prior rejection context to quick planner input when enabled', async () => {
    const prompts: string[] = [];
    const quickPlan: Planner['quickPlan'] = async (opts) => {
      prompts.push(opts.feature);
      return {
        spec: '',
        plan: '',
        tasks: [makePassingTask('T099')],
        usage: { inputTokens: 50, outputTokens: 25 },
      };
    };
    const planner = makePassingPlanner({ quickPlan });

    const result = await runSeededPlanning({
      workflow: { mode: 'quick' },
      planner,
      approval: { enabled: true, feedRejectionsToPlanner: true },
    });

    expect(result.cancelled).toBe(false);
    expect(prompts).toEqual([expect.stringContaining('Previous rejections:')]);
    expect(prompts[0]).toContain(rejectionSummary);
    expect(prompts[0]).toContain(feature);
  });

  it('does not include prior rejection context when feedRejectionsToPlanner is false', async () => {
    const prompts: string[] = [];
    const plan: Planner['plan'] = async (opts) => {
      prompts.push(opts.feature);
      return makePassingPlanner().plan(opts);
    };
    const planner = makePassingPlanner({ plan });

    const result = await runSeededPlanning({
      workflow: { mode: 'standard' },
      planner,
      approval: { enabled: true, feedRejectionsToPlanner: false },
    });

    expect(result.cancelled).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Previous rejections:');
    expect(prompts[0]).not.toContain(rejectionSummary);
    expect(prompts[0]).toContain(feature);
  });
});

describe('runPlanningPhase — rejection paths', () => {
  const rejectCases: Array<{
    name: string;
    workflow: Partial<Config['workflow']>;
    approvals: readonly ApprovalReviewResult[];
    expectPhase?: WorkflowState['phase'];
  }> = [
    {
      name: 'user rejects spec → cancelled, zero tasks, phase idle',
      workflow: manual(),
      approvals: [{ approved: false }],
      expectPhase: 'idle',
    },
    {
      name: 'user rejects plan (speckit mode) → cancelled',
      workflow: manual('speckit'),
      approvals: [{ approved: true }, { approved: false }],
    },
  ] as const;

  it.each(rejectCases)('$name', async ({ workflow, approvals, expectPhase }) => {
    const { callbacks } = makeCallbacks({ onApprovalNeeded: sequencedApproval(approvals) });
    const { result } = await runPhase({ callbacks, config: makeConfig({ workflow }) });

    expect(result.cancelled).toBe(true);
    if (expectPhase !== undefined) {
      expect(result.tasks).toHaveLength(0);
      expect(result.state.phase).toBe(expectPhase);
    }
  });
});

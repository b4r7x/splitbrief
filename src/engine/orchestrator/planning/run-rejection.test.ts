import { describe, it, expect, afterEach } from 'vitest';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { runPlanningPhase } from './run.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  TEST_METADATA,
  setupProject,
  seedRejectionEvidence,
  sequencedApproval,
  manual,
  runPlanningTurn,
  type RunOpts,
} from '#testing/helpers/planning-phase.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runTurn(opts: RunOpts = {}) {
  return runPlanningTurn(dirs, opts);
}

describe('runPlanningPhase — planner rejection context', () => {
  const feature = 'implement audited API sync';
  const rejectionSummary =
    '[sticky] network: fetch https://api.example.com/audit (reason: user denied network access)';

  async function runSeededPlanning(opts: {
    workflow: Partial<Config['workflow']>;
    approval?: Config['approval'] | undefined;
  }) {
    const { projectDir, sessionId } = setupProject(dirs);
    seedRejectionEvidence(projectDir, sessionId);
    const config = makeConfig({
      workflow: { approve: 'none', ...opts.workflow },
      ...(opts.approval ? { approval: opts.approval } : {}),
    });
    const typed = scriptedTypedCall([makePlanProposal()]);
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
      planner: makePlanner({ typedCall: typed.typedCall }),
      state: transition(createInitialState(feature), { type: 'START' }),
      feature,
    });
    return { result, prompts: typed.prompts };
  }

  it.each([
    ['by default', undefined],
    ['when enabled', { enabled: true, feedRejectionsToPlanner: true }],
  ] as const)('leads the planning session with prior rejections %s', async (_label, approval) => {
    const { result, prompts } = await runSeededPlanning({ workflow: {}, approval });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(prompts[0]).toMatch(/^Previous rejections:/);
    expect(prompts[0]).toContain(rejectionSummary);
    expect(prompts[0]).toContain(feature);
  });

  it('does not include prior rejection context when feedRejectionsToPlanner is false', async () => {
    const { result, prompts } = await runSeededPlanning({
      workflow: {},
      approval: { feedRejectionsToPlanner: false },
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(prompts[0]).not.toContain('Previous rejections:');
    expect(prompts[0]).toContain(feature);
  });
});

describe('runPlanningPhase — end-run paths', () => {
  it('user ends the run at the plan approval → closed in reviewing-plan', async () => {
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: sequencedApproval([{ approved: false, action: 'end-run' }]),
    });
    const { result } = await runTurn({ callbacks, config: makeConfig({ workflow: manual() }) });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'closed' });
    expect(result.state.closed).toEqual({ at: expect.any(String), as: 'ended' });
    expect(result.state.phase).toBe('reviewing-plan');
  });
});

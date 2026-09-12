import { describe, it, expect, afterEach } from 'vitest';
import { createPlannerBase } from '../../planners/base.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  makeCallbacks,
  makeBusRecorder,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { setupProject, REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { PlanOptions, Planner, PlannerCapabilities } from '../../planners/types.js';
import { runPlanningPhase } from './run.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';

const TRIVIAL_INSTRUCTION = 'skip the codebase-structure survey';
const REVIEW_INSTRUCTION = 'Briefly review the codebase structure';

const capabilities: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: false,
};

describe('runPlanningPhase — advisor trivial hint (REQ-056 seam)', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  async function runQuickPlanningFor(feature: string) {
    const { projectDir, sessionId } = setupProject(dirs);
    const prompts: string[] = [];
    const planOptions: PlanOptions[] = [];
    const base = createPlannerBase({
      invokePlan: async (opts) => {
        prompts.push(opts.prompt);
        return makeRunnerCallResult({ status: 'completed', text: REAL_TASKS_MD });
      },
      invokeEscalate: async () => makeRunnerCallResult({ status: 'completed', text: '' }),
      isAvailable: async () => true,
      capabilities,
    });
    const planner: Planner = {
      ...base,
      quickPlan: (options) => {
        planOptions.push(options);
        return base.quickPlan(options);
      },
    };
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config: makeConfig({ workflow: { mode: 'quick' } }),
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: transition(createInitialState(feature), { type: 'START' }),
      feature,
    });
    return { result, prompts, planOptions };
  }

  it('advisor trivial class changes quick planner prompt', async () => {
    const { result, prompts, planOptions } = await runQuickPlanningFor('fix typo in README');

    expect(result.disposition).toBe('ready-for-tasks');
    expect(planOptions[0]?.trivial).toBe(true);
    expect(prompts[0]).toContain(TRIVIAL_INSTRUCTION);
    expect(prompts[0]).not.toContain(REVIEW_INSTRUCTION);
  });

  it('ordinary work carries no trivial hint and keeps the codebase-review step', async () => {
    const { result, prompts, planOptions } = await runQuickPlanningFor(
      'add a pagination component to the results screen with tests',
    );

    expect(result.disposition).toBe('ready-for-tasks');
    expect(planOptions[0]?.trivial).toBeUndefined();
    expect(prompts[0]).toContain(REVIEW_INSTRUCTION);
    expect(prompts[0]).not.toContain(TRIVIAL_INSTRUCTION);
  });
});

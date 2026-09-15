import { describe, it, expect, vi, afterEach } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { PLAN_FILE, SPEC_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import type { RunPhaseInput } from '../../planners/types.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import {
  REAL_TASKS_MD,
  setupProject,
  makePassingTask,
  makePassingPlanner,
  makeRecordingPlanner,
  sequencedApproval,
  auto,
  manual,
  runOwnedPlanningPhase,
  type OwnedRunOpts,
} from '#testing/helpers/planning-phase.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runPhase(opts: OwnedRunOpts = {}) {
  return runOwnedPlanningPhase(dirs, opts);
}

describe('runPlanningPhase — happy paths (modes + approval)', () => {
  const happyCases: Array<{
    name: string;
    workflow: Partial<Config['workflow']>;
    approvals?: readonly ApprovalReviewResult[];
    useQuickPlan?: boolean;
  }> = [
    { name: 'auto-approve both completes without user interaction', workflow: auto() },
    {
      name: 'quick mode skips approval and uses quickPlan',
      workflow: manual('quick'),
      useQuickPlan: true,
    },
    {
      name: 'standard mode uses spec + briefs approval gates',
      workflow: manual('standard'),
      approvals: [{ approved: true }, { approved: true }],
    },
    {
      name: 'speckit mode requires spec + plan + briefs approvals',
      workflow: manual('speckit'),
      approvals: [{ approved: true }, { approved: true }, { approved: true }],
    },
  ] as const;

  it.each(happyCases)('$name', async ({ workflow, approvals, useQuickPlan }) => {
    const onApprovalNeeded = approvals ? sequencedApproval(approvals) : undefined;
    const { callbacks } = makeCallbacks(onApprovalNeeded ? { onApprovalNeeded } : undefined);
    // Distinctive task id lets us verify the quick tasks call flowed through.
    const calls: string[] = [];
    const phaseRunner = useQuickPlan
      ? vi.fn(async ({ call }: RunPhaseInput) => {
          calls.push(call);
          return makePhaseCallResult({
            call,
            usage: { inputTokens: 50, outputTokens: 25 },
            ...(call === 'tasks' ? { tasks: [makePassingTask('T099')] } : {}),
          });
        })
      : undefined;
    const planner = makePassingPlanner(phaseRunner ? { runPhase: phaseRunner } : undefined);

    const { result } = await runPhase({ planner, callbacks, config: makeConfig({ workflow }) });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    if (useQuickPlan) {
      expect(calls).toEqual(['tasks']);
      expect(result.tasks[0]?.id).toBe('T099');
    }
  });

  it('skipping the briefs approval loop still reaches implementing', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePassingPlanner();

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: auto('standard') }),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
  });

  it('user comment → spec regenerated, workflow completes', async () => {
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', comment: 'add auth section' },
      { approved: true },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    // The gate's comment goes to planner.regenerate; the revised spec then
    // invalidates the plan and the briefs, which the step loop compiles again.
    const regenArgs: Array<{ prompt: string }> = [];
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      regenerate: async (opts) => {
        regenArgs.push({ prompt: opts.prompt });
        return { text: '# Regenerated Spec\n\nauth section added.\n', usage: null };
      },
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual() }),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    expect(regenArgs).toHaveLength(1);
    expect(regenArgs[0]?.prompt).toContain('add auth section');
    expect(regenArgs[0]?.prompt).toContain('spec');
  });

  it('spec gate: editing spec.md on disk then approving regenerates plan and tasks from the edit', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { planner, calls } = makeRecordingPlanner();
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nUser-edited auth.\n', null);
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({ workflow: manual('standard') });

    const { result } = await runPhase({
      project: { projectDir, sessionId },
      planner,
      callbacks,
      config,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    const replanned = calls.filter((entry) => entry.call === 'plan');
    expect(replanned.at(-1)?.inputs.spec).toContain('User-edited auth.');
  });

  it('plan gate: editing plan.md on disk then approving regenerates tasks from the edit', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { planner, calls } = makeRecordingPlanner();
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        writeSpecFile(
          { projectDir, sessionId },
          PLAN_FILE,
          '# Plan\n\nUser-edited JWT plan.\n',
          null,
        );
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({ workflow: manual('speckit') });

    const { result } = await runPhase({
      project: { projectDir, sessionId },
      planner,
      callbacks,
      config,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    const recompiled = calls.filter((entry) => entry.call === 'tasks');
    expect(recompiled.at(-1)?.inputs.plan).toContain('User-edited JWT plan.');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { loadState } from '../../../core/state/persistence.js';
import {
  REAL_TASKS_MD,
  prepareState,
  makePassingTask,
  makePassingPlanner,
  auto,
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

describe('runPlanningPhase — rewindPending', () => {
  const rewindRegenCases: Array<{
    target: 'spec' | 'plan';
    phase: 'specifying' | 'planning';
    comment: string;
  }> = [
    { target: 'spec', phase: 'specifying', comment: 'add httpOnly cookie flag' },
    { target: 'plan', phase: 'planning', comment: 'add caching layer' },
  ];

  it.each(
    rewindRegenCases,
  )('rewindPending target=$target with comment triggers regenerate', async ({
    target,
    phase,
    comment,
  }) => {
    const regenCalls: Array<{ prompt: string }> = [];
    let planCalls = 0;
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      regenerate: async (opts) => {
        regenCalls.push({ prompt: opts.prompt });
        return { text: 'regenerated', usage: null };
      },
      plan: async () => {
        planCalls++;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    });
    const { result } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto() }),
      state: prepareState(phase),
      rewindPending: { target, comment },
    });

    expect(result.cancelled).toBe(false);
    expect(regenCalls).toHaveLength(1);
    expect(regenCalls[0]?.prompt).toContain(comment);
    expect(regenCalls[0]?.prompt).toContain(target);
    expect(planCalls).toBe(0);
  });

  const rewindRejectCases: Array<{
    target: 'spec' | 'plan';
    phase: 'specifying' | 'planning';
    mode?: 'speckit';
  }> = [
    { target: 'spec', phase: 'specifying' },
    { target: 'plan', phase: 'planning', mode: 'speckit' },
  ];

  it.each(
    rewindRejectCases,
  )('rewindPending target=$target — rejected during approval → cancelled', async ({
    target,
    phase,
    mode,
  }) => {
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }),
    });
    let planCalls = 0;
    const planner = makePassingPlanner({
      plan: async () => {
        planCalls++;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual(mode) }),
      state: prepareState(phase),
      rewindPending: { target, comment: 'reject me' },
    });

    expect(result.cancelled).toBe(true);
    expect(result.tasks).toHaveLength(0);
    expect(planCalls).toBe(0);
  });

  it('rewindPending without comment skips regen and runs from rewound phase', async () => {
    // Rewind fast-path still calls regeneratePlanAndTasks → planner.review() → parseTasks().
    let regenCalls = 0;
    let planCalls = 0;
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      regenerate: async () => {
        regenCalls++;
        return { text: 'regenerated', usage: null };
      },
      plan: async () => {
        planCalls++;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    });

    const { result } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto() }),
      state: prepareState('specifying'),
      rewindPending: { target: 'spec' },
    });

    expect(result.cancelled).toBe(false);
    expect(regenCalls).toBe(0);
    expect(planCalls).toBe(0);
    expect(result.tasks).toHaveLength(1);
  });

  it('rewind plan requires brief approval before implementation', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: auto() }),
      state: prepareState('planning'),
      rewindPending: { target: 'plan' },
    });

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).not.toBe('implementing');
    expect(result.tasks).toHaveLength(0);
    expect(onApprovalNeeded).toHaveBeenCalledWith('briefs', expect.stringContaining(TASKS_FILE));
  });

  it('rewind approval reaches implementation through briefs, not plan approval', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });

    const { result, events } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: auto() }),
      state: prepareState('planning'),
      rewindPending: { target: 'plan' },
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledWith('briefs', expect.stringContaining(TASKS_FILE));
    expect(events.some((e) => e.type === 'plan_approved' && e.phase === 'implementing')).toBe(true);
  });

  it('rewind-to-spec publishes a running planner_status at the specifying phase', async () => {
    const { events } = await runPhase({
      planner: makePassingPlanner({
        review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      }),
      config: makeConfig({ workflow: auto() }),
      state: prepareState('specifying'),
      rewindPending: { target: 'spec' },
    });

    const specifyingRunning = events.find(
      (e) => e.type === 'planner_status' && e.status === 'running' && e.phase === 'specifying',
    );
    expect(specifyingRunning).toBeDefined();
  });

  it('rewindPending cleared on resulting state after regeneration', async () => {
    const { result } = await runPhase({
      planner: makePassingPlanner({
        review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      }),
      config: makeConfig({ workflow: auto() }),
      state: {
        ...prepareState('specifying'),
        rewindPending: { target: 'spec', comment: 'use JWT' },
      },
      rewindPending: { target: 'spec', comment: 'use JWT' },
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.rewindPending).toBeUndefined();
  });

  it('does not persist transient rewind feedback if planning fails before rewind is cleared', async () => {
    const secret = 'secret raw rewind comment';
    const protectedComment = '[transcript omitted]';
    await expect(
      runPhase({
        config: makeConfig({
          workflow: { ...auto(), persistTranscript: false },
          codebase: { enabled: false, tokenBudget: 1, cacheDir: '.splitbrief/codebase-cache' },
        }),
        state: prepareState('specifying', { target: 'spec', comment: protectedComment }),
        rewindPending: { target: 'spec', comment: protectedComment },
        rewindFeedback: secret,
        drainPendingAttachments: () => {
          throw new Error('attachment drain failed');
        },
      }),
    ).rejects.toThrow('attachment drain failed');

    const projectDir = dirs.at(-1);
    if (projectDir === undefined) throw new Error('Expected planning test project');
    const saved = loadState({ projectDir, sessionId: 'sess-planning' });
    expect(saved?.rewindPending).toEqual({ target: 'spec', comment: protectedComment });
    expect(JSON.stringify(saved)).not.toContain(secret);
  });

  const rewindSpecGateCases: Array<{
    name: string;
    workflow: Partial<ReturnType<typeof manual>>;
    prompts: boolean;
  }> = [
    {
      name: "approve 'spec' prompts the rewound spec",
      workflow: { approve: 'spec' },
      prompts: true,
    },
    { name: "approve 'all' prompts the rewound spec", workflow: { approve: 'all' }, prompts: true },
    {
      name: "approve 'plan' skips the rewound spec gate",
      workflow: { approve: 'plan' },
      prompts: false,
    },
    {
      name: "approve 'none' skips the rewound spec gate",
      workflow: { approve: 'none' },
      prompts: false,
    },
    {
      name: "approve 'spec' overrides a hand-set autoApproveSpec flag",
      workflow: { approve: 'spec', autoApproveSpec: true },
      prompts: true,
    },
    {
      name: 'both legacy auto flags skip the rewound spec gate',
      workflow: { autoApproveSpec: true, autoApprovePlan: true },
      prompts: false,
    },
  ];

  it.each(rewindSpecGateCases)('rewind-to-spec gate honors workflow.approve — $name', async ({
    workflow,
    prompts,
  }) => {
    const approvalTypes: string[] = [];
    const onApprovalNeeded = vi.fn(async (type: string) => {
      approvalTypes.push(type);
      return { approved: true as const };
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result } = await runPhase({
      planner: makePassingPlanner({
        review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      }),
      callbacks,
      config: makeConfig({ workflow }),
      state: prepareState('specifying'),
      rewindPending: { target: 'spec' },
    });

    expect(result.cancelled).toBe(false);
    expect(approvalTypes.includes('spec')).toBe(prompts);
  });

  it('speckit mode new-planning (no rewind) invokes planner.plan exactly once', async () => {
    let planCalls = 0;
    let regenCalls = 0;
    const planner = makePassingPlanner({
      plan: async () => {
        planCalls++;
        // Distinctive task id proves these tasks came from plan(), not a stale
        // path. If plan() were called more than once, the result would come
        // from the last call but we assert the counter directly.
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask('T099')],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
      regenerate: async () => {
        regenCalls++;
        return { text: 'regenerated', usage: null };
      },
    });
    const { result } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto('speckit') }),
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T099');
    expect(result.state.phase).toBe('implementing');
    expect(planCalls).toBe(1);
    expect(regenCalls).toBe(0);
  });
});

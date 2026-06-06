import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { TASKS_FILE } from '../../../core/paths.js';
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
          tasks: [makePassingTask('T-FROMPLAN')],
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
    expect(result.tasks[0]?.id).toBe('T-FROMPLAN');
    expect(result.state.phase).toBe('implementing');
    expect(planCalls).toBe(1);
    expect(regenCalls).toBe(0);
  });
});

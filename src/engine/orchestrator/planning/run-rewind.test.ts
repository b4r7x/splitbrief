import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeWctx,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import { readSpecFile, readSpecFileOrEmpty, writeSpecFile } from '../../../core/paths-io.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { runPlanningPhases } from '../run/phases.js';
import {
  REAL_TASKS_MD,
  prepareState,
  makePassingTask,
  makePassingPlanner,
  auto,
  manual,
  setupProject,
  createTestSinks,
  type RunOpts,
} from '#testing/helpers/planning-phase.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

async function runPhase(
  opts: RunOpts & { project?: { projectDir: string; sessionId: string } } = {},
) {
  const { projectDir, sessionId } = opts.project ?? setupProject(dirs);
  const planner = opts.planner ?? makePassingPlanner();
  const callbacks = opts.callbacks ?? makeCallbacks().callbacks;
  const config = opts.config ?? makeConfig();
  const state = opts.state ?? prepareState();
  const planningState: WorkflowState = {
    ...state,
    ...(opts.rewindPending ? { rewindPending: opts.rewindPending } : {}),
  };
  const sinks = opts.sinks ?? createTestSinks();
  const recorder = makeBusRecorder();
  const stateRef = { projectDir, sessionId };
  const wctx = makeWctx({
    projectDir,
    sessionId,
    config,
    callbacks,
    planner,
    metadata: TEST_METADATA,
    sinks,
    bus: recorder.bus,
    ...(opts.drainPendingAttachments !== undefined && {
      drainPendingAttachments: opts.drainPendingAttachments,
    }),
  });
  saveState(stateRef, planningState);
  let trackedState = planningState;
  const result = await runPlanningPhases({
    wctx,
    state: planningState,
    savedState: planningState.rewindPending === undefined ? undefined : planningState,
    selectedSkills: undefined,
    phaseTimings: {},
    startTime: Date.now(),
    setTrackedState: (next) => {
      trackedState = next;
    },
    ...(opts.rewindFeedback !== undefined && { rewindFeedback: opts.rewindFeedback }),
  });
  return {
    result: { ...result, tasks: trackedState.tasks },
    projectDir,
    sessionId,
    events: recorder.events,
  };
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

  it.each(rewindRegenCases)(
    'rewindPending target=$target with comment triggers regenerate',
    async ({ target, phase, comment }) => {
      const project = setupProject(dirs);
      writeSpecFile(
        { projectDir: project.projectDir, sessionId: project.sessionId },
        TASKS_FILE,
        '# Prior Task Briefs\n\nUnchanged.\n',
        TEST_METADATA,
      );
      const regenCalls: Array<{ prompt: string }> = [];
      let planCalls = 0;
      const planner = makePassingPlanner({
        review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
        regenerate: async (opts) => {
          regenCalls.push({ prompt: opts.prompt });
          return { text: `# Regenerated ${target}`, usage: null };
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
      const { result, projectDir, sessionId, events } = await runPhase({
        planner,
        config: makeConfig({ workflow: auto() }),
        state: prepareState(phase),
        rewindPending: { target, comment },
        project,
      });

      expect(result.disposition).toBe('ready-for-tasks');
      expect(regenCalls).toHaveLength(1);
      expect(regenCalls[0]?.prompt).toContain(comment);
      expect(regenCalls[0]?.prompt).toContain(target);
      expect(planCalls).toBe(0);
      expect(
        readSpecFileOrEmpty({ projectDir, sessionId }, target === 'spec' ? SPEC_FILE : PLAN_FILE),
      ).toContain(`# Regenerated ${target}`);
      const targetFile = target === 'spec' ? SPEC_FILE : PLAN_FILE;
      expect(
        events.filter(
          (event) => event.type === 'artifact_written' && event.filename === targetFile,
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === `${target}_regenerated`)).toHaveLength(1);
      const projectedBriefs = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
      expect(projectedBriefs).toContain('id: T001');
      expect(projectedBriefs).toContain('title: Add auth');
      expect(projectedBriefs).not.toContain('# Prior Task Briefs');
    },
  );

  const invalidRewindCases: Array<{
    target: 'spec' | 'plan';
    phase: 'specifying' | 'planning';
    filename: string;
  }> = [
    { target: 'spec', phase: 'specifying', filename: SPEC_FILE },
    { target: 'plan', phase: 'planning', filename: PLAN_FILE },
  ];

  it.each(invalidRewindCases)(
    'rejects invalid $target replacement without writing, publishing, or generating Task Briefs',
    async ({ target, phase, filename }) => {
      const project = setupProject(dirs);
      writeSpecFile(
        { projectDir: project.projectDir, sessionId: project.sessionId },
        TASKS_FILE,
        '# Prior Task Briefs\n\nUnchanged.\n',
        TEST_METADATA,
      );
      const priorTasksBytes = readSpecFile(
        { projectDir: project.projectDir, sessionId: project.sessionId },
        TASKS_FILE,
      );
      const previous = `# Existing ${target}\n\nKeep this artifact.`;
      const planner = makePassingPlanner({
        regenerate: async ({ projectDir }) => {
          writeSpecFile({ projectDir, sessionId: 'sess-planning' }, filename, previous);
          return {
            text: 'Which scope should this planning artifact cover?',
            usage: null,
          };
        },
        review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      });

      const { result, projectDir, sessionId, events } = await runPhase({
        planner,
        config: makeConfig({ workflow: auto() }),
        state: prepareState(phase),
        rewindPending: { target, comment: `reject this ${target}` },
        project,
      });

      expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed', tasks: [] });
      expect(readSpecFileOrEmpty({ projectDir, sessionId }, filename)).toBe(previous);
      expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
      expect(events.filter((event) => event.type === `${target}_regenerated`)).toHaveLength(0);
      expect(planner.review).not.toHaveBeenCalled();
      expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
    },
  );

  it('rebases planner usage when rewind admission fails', async () => {
    const planner = makePassingPlanner({
      regenerate: vi.fn().mockResolvedValue({
        text: 'Which planning artifact should this be?',
        usage: { inputTokens: 17, outputTokens: 5 },
      }),
    });

    const { result, projectDir, sessionId, events } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto() }),
      state: prepareState('planning'),
      rewindPending: { target: 'plan', comment: 'reject and retain usage' },
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed', tasks: [] });
    expect(result.state.tokenUsage).toMatchObject({ plannerInput: 17, plannerOutput: 5 });
    expect(loadState({ projectDir, sessionId })?.tokenUsage).toMatchObject({
      plannerInput: 17,
      plannerOutput: 5,
    });
    expect(events.find((event) => event.type === 'error')).toEqual(
      expect.objectContaining({ message: expect.stringContaining('Invalid planning artifact') }),
    );
    expect(planner.review).not.toHaveBeenCalled();
  });

  it('drains queued rewind input exactly once before valid plan regeneration', async () => {
    let prompt = '';
    const queuedAt = new Date().toISOString();
    const planner = makePassingPlanner({
      regenerate: async (opts) => {
        prompt = opts.prompt;
        return { text: '# Regenerated plan', usage: null };
      },
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });
    const state = {
      ...prepareState('planning'),
      messageQueue: [
        {
          id: 'rewind-message',
          text: 'also preserve the queue contract',
          queuedAt,
          phase: 'planning' as const,
          deliveredViaNative: false,
          nativeDeliveryState: 'pending' as const,
        },
      ],
    };

    const { result, events } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto() }),
      state,
      rewindPending: { target: 'plan', comment: 'keep the queue input' },
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(prompt).toContain('also preserve the queue contract');
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ count: 1, ids: ['rewind-message'] }),
    ]);
  });

  const rewindRejectCases: Array<{
    target: 'spec' | 'plan';
    phase: 'specifying' | 'planning';
    mode?: 'speckit';
  }> = [
    { target: 'spec', phase: 'specifying' },
    { target: 'plan', phase: 'planning', mode: 'speckit' },
  ];

  it.each(rewindRejectCases)(
    'rewindPending target=$target — rejected during approval → cancelled',
    async ({ target, phase, mode }) => {
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

      expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
      expect(result.tasks).toHaveLength(0);
      expect(planCalls).toBe(0);
    },
  );

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

    expect(result.disposition).toBe('ready-for-tasks');
    expect(regenCalls).toBe(0);
    expect(planCalls).toBe(0);
    expect(result.tasks).toHaveLength(1);
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
        regenerate: vi.fn().mockResolvedValue({ text: '# Regenerated spec', usage: null }),
      }),
      config: makeConfig({ workflow: auto() }),
      state: {
        ...prepareState('specifying'),
        rewindPending: { target: 'spec', comment: 'use JWT' },
      },
      rewindPending: { target: 'spec', comment: 'use JWT' },
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.rewindPending).toBeUndefined();
  });

  it('does not persist transient rewind feedback if planning fails before rewind is cleared', async () => {
    const secret = 'secret raw rewind comment';
    const protectedComment = '[transcript omitted]';
    await expect(
      runPhase({
        config: makeConfig({
          workflow: { ...auto() },
          codebase: { enabled: false, tokenBudget: 1 },
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
      name: "approve 'default' prompts the rewound spec",
      workflow: { approve: 'default' },
      prompts: true,
    },
  ];

  it.each(rewindSpecGateCases)(
    'rewind-to-spec gate honors workflow.approve — $name',
    async ({ workflow, prompts }) => {
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

      expect(result.disposition).toBe('ready-for-tasks');
      expect(approvalTypes.includes('spec')).toBe(prompts);
    },
  );

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

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T099');
    expect(result.state.phase).toBe('implementing');
    expect(planCalls).toBe(1);
    expect(regenCalls).toBe(0);
  });
});

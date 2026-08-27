import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  BRIEF_QUALITY_FILE,
  BRIEF_READINESS_FILE,
  sessionDir,
  TASKS_FILE,
} from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import { runPlanningPhases } from '../run/phases.js';
import { createWorkflowRecoveryBinding } from '../run/recovery-binding.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { createPlannerBase, installCompilerSeam, type CompilerSeam } from '../../planners/base.js';
import type { CompilerCapabilityReceipt } from '../../runners/compiler-capability.js';
import { readRuntimeConformance } from '../../runners/runtime-conformance-cache.js';
import { TaskCompilationOperationIdSchema } from '../../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
} from '../../calls/dispatch-ledger.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { PlannerCapabilities } from '../../planners/types.js';
import type { PlanningPhaseOptions } from './types.js';
import {
  TEST_METADATA,
  REAL_TASKS_MD,
  setupProject,
  makePassingTask,
  makeBriefQualityFailureTask,
  makePassingPlanner,
  prepareState,
  sequencedApproval,
  type RunOpts,
} from '#testing/helpers/planning-phase.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { formatTasks } from '../../spec/formatter.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function completedRunnerCall(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

function readinessDecisionBriefHash(projectDir: string, sessionId: string): string | undefined {
  const recovery = readWorkflowStateHead({ projectDir, sessionId })?.state.briefRecovery;
  return recovery !== null && recovery !== undefined && 'readinessDecision' in recovery
    ? recovery.readinessDecision?.briefHash
    : undefined;
}

type TestPlanningOptions = Omit<PlanningPhaseOptions, 'recovery'>;

type TestPlanningResult = Awaited<ReturnType<typeof runPlanningPhases>> & { tasks: Task[] };

async function runPlanningPhase(opts: TestPlanningOptions): Promise<TestPlanningResult> {
  const { projectDir, sessionId } = opts.wctx;
  const state: WorkflowState = {
    ...opts.state,
    stateFence: { token: 1, ownerId: 'briefs-approval-test-owner' },
  };
  saveState({ projectDir, sessionId }, state);
  let trackedState = state;
  const stateRef = { projectDir, sessionId };
  const wctx = makeWctx({
    ...opts.wctx,
    projectDir,
    sessionId,
    planner: opts.planner,
  });
  const authorityBase: Omit<StateAuthorityReceipt, 'stateDigest' | 'stateRevision'> = {
    kind: 'usable',
    sessionId,
    ownerId: 'briefs-approval-test-owner',
    pid: process.pid,
    processStart: 'briefs-approval-test-process',
    runId: 'briefs-approval-test-run',
    acquisitionId: 'briefs-approval-test-acquisition',
    fence: 1,
  };
  const getState = (): WorkflowState => readWorkflowStateHead(stateRef)?.state ?? trackedState;
  const getAuthority = (): StateAuthorityReceipt => {
    const head = readWorkflowStateHead(stateRef);
    return {
      ...authorityBase,
      stateRevision: head?.state.stateRevision ?? trackedState.stateRevision ?? 0,
      stateDigest: head?.digest ?? '',
    };
  };
  const recovery = createWorkflowRecoveryBinding({
    wctx,
    getState,
    setState: (next) => {
      trackedState = next;
    },
    getAuthority,
  });
  const result = await runPlanningPhases({
    wctx,
    state,
    savedState: state.rewindPending === undefined ? undefined : state,
    selectedSkills: opts.selectedSkills,
    phaseTimings: {},
    startTime: Date.now(),
    setTrackedState: (next) => {
      trackedState = next;
    },
    ...(opts.rewindFeedback !== undefined && { rewindFeedback: opts.rewindFeedback }),
    recovery,
  });
  return { ...result, tasks: trackedState.tasks };
}

async function runPhase(opts: RunOpts = {}) {
  const { projectDir, sessionId } = setupProject(dirs);
  const planner = opts.planner ?? makePassingPlanner();
  const callbacks = opts.callbacks ?? makeCallbacks().callbacks;
  const config = opts.config ?? makeConfig();
  const state = opts.state ?? prepareState(undefined, opts.rewindPending);
  const recorder = makeBusRecorder();
  const result = await runPlanningPhase({
    wctx: {
      projectDir,
      sessionId,
      config,
      callbacks,
      metadata: TEST_METADATA,
      bus: recorder.bus,
      sinks: opts.sinks ?? { setAbortHandler: () => {}, setQueueHandler: () => {} },
      ...(opts.drainPendingAttachments !== undefined && {
        drainPendingAttachments: opts.drainPendingAttachments,
      }),
    },
    planner,
    state,
    feature: 'test-feature',
    ...(opts.rewindPending !== undefined && { rewindPending: opts.rewindPending }),
    ...(opts.rewindFeedback !== undefined && { rewindFeedback: opts.rewindFeedback }),
  });
  return { result, projectDir, sessionId, events: recorder.events };
}

function makePricedBriefReviewConfig(
  overrides: NonNullable<Parameters<typeof makeConfig>[0]> = {},
) {
  return makeConfig({
    ...overrides,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiBase: 'https://api.anthropic.com/v1',
    },
  });
}

describe('runPlanningPhase — briefs approval loop', () => {
  it('terminates with quality failure for invalid briefs in standard mode without prompting when automatic repair is exhausted', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makeBriefQualityFailureTask()],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });
    const initial = createInitialState('feature');

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('terminal');
    if (result.disposition === 'terminal') {
      expect(result.outcome).toBe('failed');
    }
    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(persisted.passed).toBe(false);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('fails closed when called without the workflow owner recovery binding', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const state = { ...createInitialState('feature'), phase: 'reviewing-plan' as const };

    const result = await runBriefsApprovalLoop({
      tasks: [makePassingTask()],
      planner: makePassingPlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(result).toMatchObject({ state, rejected: false, outcome: 'failed' });
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) => event.type === 'warning' && event.code === 'brief_recovery_unavailable',
      ),
    ).toBe(true);
  });

  it('standard mode refreshes readiness and warns when a brief overflows workers, and a decline ends the run rejected', async () => {
    const overflowingTask = makePassingTask('T001');
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [
          {
            ...overflowingTask,
            description: 'Create a large worker packet',
            implementationSteps: [
              Array.from({ length: 300 }, (_, index) => `implement detail ${index}`).join(' '),
            ],
          },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: false }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      implementer: { contextLength: 200 },
      workflow: { mode: 'standard', approve: 'none' },
    });

    const { result, events } = await runPhase({ planner, callbacks, config });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(result.state.phase).toBe('idle');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message.includes('Task Brief approval blocked') &&
          event.message.includes('T001') &&
          event.message.includes('Approve again without editing tasks.md to proceed anyway'),
      ),
    ).toBe(true);
  });

  it('hands the readiness gate the routing inputs it received, so a brief only the cache window fits is approved once', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [
          {
            ...makePassingTask('T001'),
            // Overflows DEFAULT_UNKNOWN_CONTEXT_LENGTH; fits only the cached 200k window.
            description: 'implement the oversized packet. '.repeat(6000),
          },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: false }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
      implementerProfiles: {
        default: 'local-agent',
        profiles: {
          'local-agent': {
            kind: 'agent',
            command: 'local-worker',
            model: 'local-model',
            costTier: 'cheap',
          },
          'catalog-api': {
            kind: 'api',
            provider: 'openrouter',
            apiBase: 'https://openrouter.ai/api/v1',
            apiKey: 'test-key',
            model: 'runtime-wide',
            costTier: 'standard',
          },
        },
      },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        modelCache: makeModelCacheAccessor({
          providerModels: { openrouter: [{ id: 'runtime-wide', contextLength: 200_000 }] },
        }),
        detectedContextLength: 4_096,
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), BRIEF_READINESS_FILE), 'utf8'),
    );
    expect(persisted.ok).toBe(true);
    expect(persisted.metadata[0].contextLength).toBe(200_000);
    expect(
      events.some((event) => event.type === 'warning' && event.code === 'brief_readiness_block'),
    ).toBe(false);
  });

  it('brief edit reloads persisted tasks.md and quality-gates it before approval', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, REAL_TASKS_MD, 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks[0]?.title).toBe('Add auth');
  });

  it('brief edit refreshes readiness and warns when the edited tasks.md overflows workers', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const overflowingTask = makePassingTask('T001');
    const overflowingTasks = formatTasks([
      {
        ...overflowingTask,
        description: 'Create a large worker packet',
        implementationSteps: [
          Array.from({ length: 300 }, (_, index) => `implement detail ${index}`).join(' '),
        ],
      },
    ]);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, overflowingTasks, 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      implementer: { contextLength: 200 },
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(result.state.phase).toBe('idle');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message.includes('Task Brief approval blocked') &&
          event.message.includes('Approve again without editing tasks.md to proceed anyway'),
      ),
    ).toBe(true);
  });

  it('warns on the bus when an edited tasks.md has an unknown ### section (F-429 / N399)', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const editedWithUnknownSection = `${REAL_TASKS_MD}
### Hand-Edited Notes

- this heading is outside the canonical grammar and will be dropped
`;
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, editedWithUnknownSection, 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    const warning = events.find(
      (e) => e.type === 'warning' && e.message.includes('Hand-Edited Notes'),
    );
    expect(warning).toBeDefined();
  });

  it('warns exactly once when generated briefs have an unknown ### section and are plain-approved (F-429 / N399 no double-warn)', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const capabilities: PlannerCapabilities = {
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
      supportsSessionResume: false,
      supportsEffort: false,
      supportsImages: false,
      supportsSelfSummarisation: false,
    };
    const tasksWithUnknownSection = `${REAL_TASKS_MD}
### Future Considerations

- this heading is outside the canonical grammar and will be dropped
`;
    const planner = createPlannerBase({
      invokePlan: async ({ artifactFile }) =>
        completedRunnerCall(artifactFile === TASKS_FILE ? tasksWithUnknownSection : '# doc'),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities,
    });
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn<OrchestratorCallbacks['onApprovalNeeded']>()
        .mockResolvedValue({ approved: true }),
    });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    const warnings = events.filter(
      (e) => e.type === 'warning' && e.message.includes('Future Considerations'),
    );
    expect(warnings).toHaveLength(1);
  });

  it('approve rewrites missing tasks.md from current tasks and reparses once', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        rmSync(tasksPath, { force: true });
        return { approved: true };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(existsSync(tasksPath)).toBe(true);
  });

  it('approve keeps review open when persisted tasks.md is empty', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, '', 'utf8');
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(result.state.phase).toBe('idle');
  });

  it('briefs comment → tasks regenerated via planner.review, loop continues, user then approves', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const reviewPrompts: string[] = [];
    const planner = makePassingPlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: REAL_TASKS_MD, usage: null };
      },
    });
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', comment: 'add scope definitions to all tasks' },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makePricedBriefReviewConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });
    const initial = createInitialState('feature');

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks).toHaveLength(1);
    expect(reviewPrompts).toEqual([expect.stringContaining('add scope definitions to all tasks')]);
  });

  it('does not freeze released feedback on a later manual retry', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const review = vi
      .fn()
      .mockResolvedValueOnce({
        text: formatTasks([makeBriefQualityFailureTask()]),
        usage: null,
      })
      .mockResolvedValueOnce({ text: REAL_TASKS_MD, usage: null });
    const planner = makePassingPlanner({ review });
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', comment: 'make the scope explicit' },
      { approved: false, action: 'retry' } as never,
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makePricedBriefReviewConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('parked');
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('targeted brief revision task ids generate targeted planner feedback', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const reviewPrompts: string[] = [];
    const regeneratedTasks = [makePassingTask('T001'), makePassingTask('T002')];
    const planner = makePassingPlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: regeneratedTasks,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: formatTasks(regeneratedTasks), usage: null };
      },
    });
    const onApprovalNeeded = sequencedApproval([
      {
        approved: false,
        action: 'revise',
        comment: 'narrow this implementation',
        taskIds: [taskId('T002')],
      },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makePricedBriefReviewConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(reviewPrompts[0]).toContain('The user has flagged the following tasks');
    expect(reviewPrompts[0]).toContain('- T002:');
    expect(reviewPrompts[0]).toContain('User reason: narrow this implementation');
    expect(reviewPrompts[0]).toContain('Regenerate ONLY the flagged tasks above');
    expect(reviewPrompts[0]).toContain('Keep every other task unchanged');
  });

  it('rejects targeted brief revision when any requested task id is unknown', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const review = vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const planner = makePassingPlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makePassingTask('T001'), makePassingTask('T002')],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      review,
    });
    const onApprovalNeeded = sequencedApproval([
      {
        approved: false,
        action: 'revise',
        comment: 'focus this brief',
        taskIds: [taskId('T999')],
      },
      { approved: false },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(review).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          event.message === 'Unknown Task Brief ID for targeted revision: T999',
      ),
    ).toBe(true);
  });

  it('builds targeted feedback from the latest persisted Task Brief draft', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const reviewPrompts: string[] = [];
    const initialTasks = [makePassingTask('T001')];
    const draftTasks = [
      makePassingTask('T001'),
      {
        ...makePassingTask('T010'),
        title: 'Saved draft task',
        file: 'src/saved-draft.ts',
        scope: {
          inBounds: ['Modify only `src/saved-draft.ts`.'],
          outOfBounds: ['Do not touch anything outside the task file.'],
        },
      },
    ];
    const planner = makePassingPlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: initialTasks,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: formatTasks(draftTasks), usage: null };
      },
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks(draftTasks), null);
        return {
          approved: false,
          action: 'revise',
          comment: 'tighten the draft',
          taskIds: [taskId('T010')],
        };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makePricedBriefReviewConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(reviewPrompts[0]).toContain('- T010: "Saved draft task" (src/saved-draft.ts)');
    expect(reviewPrompts[0]).toContain('Regenerate ONLY the flagged tasks above');
    expect(reviewPrompts[0]).toContain('Keep every other task unchanged');
  });

  it('applies queued planner input before first brief review when spec and plan gates are skipped', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const reviewPrompts: string[] = [];
    const planner = makePassingPlanner({
      plan: async () => {
        const current = readWorkflowStateHead({ projectDir, sessionId })?.state;
        if (current === undefined) throw new Error('expected the owner state head');
        saveState(
          { projectDir, sessionId },
          {
            ...current,
            messageQueue: [
              {
                id: 'queued-before-briefs',
                text: 'make the task brief include the CLI retry case',
                queuedAt: new Date().toISOString(),
                phase: 'planning',
                deliveredViaNative: false,
                nativeDeliveryState: 'pending',
                origin: 'user-input',
              },
            ],
          },
        );
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 50, outputTokens: 25 },
        };
      },
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: REAL_TASKS_MD, usage: null };
      },
    });
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });
    const initial = createInitialState('feature');

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith('briefs', expect.stringContaining(TASKS_FILE));
    expect(reviewPrompts).toEqual([
      expect.stringContaining('make the task brief include the CLI retry case'),
    ]);
    expect(events.some((event) => event.type === 'queue_drained' && event.count === 1)).toBe(true);
  });

  it('persists a readiness block until a second approval over the same report reaches implementing', async () => {
    const overflowingTask = makePassingTask('T001');
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [
          {
            ...overflowingTask,
            description: 'Create a large worker packet',
            implementationSteps: [
              Array.from({ length: 300 }, (_, index) => `implement detail ${index}`).join(' '),
            ],
          },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: true }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      implementer: { contextLength: 200 },
      workflow: { mode: 'standard', approve: 'none' },
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
  });

  it('editing tasks.md between the two approvals cancels the pending override', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const overflowingTask = makePassingTask('T001');
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [
          {
            ...overflowingTask,
            description: 'Create a large worker packet',
            implementationSteps: [
              Array.from({ length: 300 }, (_, index) => `implement detail ${index}`).join(' '),
            ],
          },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const editedOverflowing = formatTasks([
      {
        ...makePassingTask('T002'),
        title: 'Edited overflowing brief',
        description: 'Create an even larger worker packet',
        implementationSteps: [
          Array.from({ length: 300 }, (_, index) => `edited detail ${index}`).join(' '),
        ],
      },
    ]);
    let blockedBeforeEditHash: string | undefined;
    let blockedAfterEditHash: string | undefined;
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        blockedBeforeEditHash = readinessDecisionBriefHash(projectDir, sessionId);
        writeFileSync(tasksPath, editedOverflowing, 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        blockedAfterEditHash = readinessDecisionBriefHash(projectDir, sessionId);
        return { approved: true };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makeConfig({
      implementer: { contextLength: 200 },
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(4);
    expect(blockedBeforeEditHash).toEqual(expect.any(String));
    expect(blockedAfterEditHash).toEqual(expect.any(String));
    expect(blockedAfterEditHash).not.toBe(blockedBeforeEditHash);
  });

  it('a revise that changes only brief prose, leaving the task set identical, still terminates without the no-progress error', async () => {
    const overflowingTask = makePassingTask('T001');
    const planTask: Task = {
      ...overflowingTask,
      description: 'Create a large worker packet',
      implementationSteps: [
        Array.from({ length: 300 }, (_, index) => `implement detail ${index}`).join(' '),
      ],
    };
    const planTasks = [planTask];
    const planner = makePassingPlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: planTasks,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      review: async () => ({
        text: formatTasks([
          {
            ...planTask,
            description: 'Create a large worker packet (revised prose)',
            implementationSteps: [
              Array.from({ length: 300 }, (_, index) => `implement revised detail ${index}`).join(
                ' ',
              ),
            ],
          },
        ]),
        usage: null,
      }),
    });
    const onApprovalNeeded = sequencedApproval([
      { approved: true },
      { approved: false, action: 'revise', comment: 'keep the same tasks, improve the prose' },
      { approved: true },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makePricedBriefReviewConfig({
      implementer: { contextLength: 200 },
      workflow: { mode: 'standard', approve: 'none' },
    });

    const { result, events } = await runPhase({ planner, callbacks, config });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(4);
    expect(
      events.some((event) => event.type === 'error' && event.code === 'brief_review_no_progress'),
    ).toBe(false);
  });

  it('an always-editing callback over an unfixable plan stops one prompt past the no-progress cap and ends rejected', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const overflowingTasks = formatTasks([
      {
        ...makePassingTask('T001'),
        description: 'Create a large worker packet',
        implementationSteps: [
          Array.from({ length: 300 }, (_, index) => `implement detail ${index}`).join(' '),
        ],
      },
    ]);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementation(async () => {
        writeFileSync(tasksPath, overflowingTasks, 'utf8');
        return { approved: false, action: 'edit' };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      implementer: { contextLength: 200 },
      workflow: { mode: 'standard', approve: 'none' },
    });

    const { result, events } = await runPhase({ planner, callbacks, config });

    expect(onApprovalNeeded.mock.calls.length).toBeLessThanOrEqual(21);
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(result.state.phase).toBe('idle');
    expect(
      events.some((event) => event.type === 'error' && event.code === 'brief_review_no_progress'),
    ).toBe(true);
  });

  it('a readiness block reached through the edit path persists until a re-confirmation', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const overflowingTasks = formatTasks([
      {
        ...makePassingTask('T001'),
        description: 'Create a large worker packet',
        implementationSteps: [
          Array.from({ length: 300 }, (_, index) => `implement detail ${index}`).join(' '),
        ],
      },
    ]);
    let blockedBriefHash: string | undefined;
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, overflowingTasks, 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        blockedBriefHash = readinessDecisionBriefHash(projectDir, sessionId);
        return { approved: true };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      implementer: { contextLength: 200 },
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(3);
    expect(blockedBriefHash).toEqual(expect.any(String));
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.code === 'brief_readiness_blocked' &&
          event.message.includes('Approve again without editing tasks.md to proceed anyway'),
      ),
    ).toBe(true);
  });
  it('records the drifted planner runtime in the conformance cache once approved briefs settle', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner();
    const receipt: CompilerCapabilityReceipt = {
      backend: 'opencode',
      version: '1.18.15',
      runtimeVersion: '1.19.0',
      versionObservation: 'drifted',
      role: 'planner-read-only',
      transport: 'stdout-final',
      terminalContract: 'opencode-final-message-v1',
      containmentProfile: 'seatbelt',
      credentialChannel: 'session-copy',
      envelopeVersion: 1,
      fixtureDate: '2026-08-15',
      capabilityDigest: '0000000000000000000000000000000000000000000000000000000000000000',
    };
    const seam: CompilerSeam = {
      invocation: {
        runtime: {
          executablePath: '/usr/bin/opencode',
          version: '1.18.15',
          runtimeDigest: 'digest',
          protocolDigest: 'protocol-digest',
        },
        role: 'planner-read-only',
        transport: { kind: 'stdout-final' },
        terminalContract: 'opencode-final-message-v1',
        envelope: {
          version: 1,
          promptBytes: 1000,
          inputTokensUpperBound: 1000,
          requestedOutputTokens: 1000,
          outputTokensUpperBound: 1000,
          maxNormalizedOutputBytes: 1000,
          maxDeclaredArtifactBytes: 1000,
          maxRawProtocolBytes: 1000,
          maxStderrBytes: 1000,
          deadlineMs: 1000,
          idleTimeoutMs: 1000,
        },
        capabilityDigest: receipt.capabilityDigest,
      },
      ledger: createTaskDispatchLedger({
        operation: {
          version: 1,
          dispatchLimit: 64,
          callCount: 0,
          totalPromptBytes: 0,
          totalInputTokensUpperBound: 0,
          totalOutputTokensUpperBound: 0,
          totalNormalizedOutputBytes: 0,
          totalDeclaredArtifactBytes: 0,
          callsDigest: 'calls-digest',
        },
        operationId: TaskCompilationOperationIdSchema.parse('operation-approval-drift'),
        claimPort: createTaskDispatchClaimPort(),
      }),
      dispatch: vi.fn(),
      receipt,
    };
    installCompilerSeam(planner, seam);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.state.phase).toBe('implementing');
    expect(readRuntimeConformance(projectDir)?.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ backend: 'opencode', version: '1.19.0' })]),
    );
  });
});

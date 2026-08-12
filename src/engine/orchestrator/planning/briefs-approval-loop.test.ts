import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  BRIEF_QUALITY_FILE,
  BRIEF_READINESS_FILE,
  sessionDir,
  TASKS_FILE,
} from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { runPlanningPhase } from './run.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import { createPlannerBase } from '../../planners/base.js';
import type { OrchestratorCallbacks } from '../types.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { PlannerCapabilities } from '../../planners/types.js';
import {
  TEST_METADATA,
  REAL_TASKS_MD,
  setupProject,
  makePassingTask,
  makeBriefQualityFailureTask,
  makePassingPlanner,
  sequencedApproval,
  runPhase as runPhaseHelper,
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

function runPhase(opts: RunOpts = {}) {
  return runPhaseHelper(dirs, opts);
}

describe('runPlanningPhase — briefs approval loop', () => {
  it('enters reviewing-briefs phase for invalid briefs in standard mode (user can reject)', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePassingPlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makeBriefQualityFailureTask()],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: false }]);
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

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(persisted.passed).toBe(false);
    const failed = events.find((e) => e.type === 'brief_quality_failed');
    expect(failed).toBeDefined();
  });

  it('standard mode blocks approval when persisted tasks.md fails quality', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makeBriefQualityFailureTask()],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const onApprovalNeeded = sequencedApproval([
      { approved: true },
      { approved: true },
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

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(events.filter((e) => e.type === 'brief_quality_failed').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('standard mode refreshes readiness and warns when a brief overflows workers, and a repeated approval overrides', async () => {
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

    expect(result.cancelled).toBe(true);
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

    expect(result.cancelled).toBe(false);
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

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks[0]?.title).toBe('Add auth');
  });

  it('skips the first approval quality gate for unchanged pre-reviewed tasks', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const tasks = [makePassingTask()];
    const planner = makePassingPlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: true }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await runBriefsApprovalLoop({
      tasks,
      qualityValidatedTasks: tasks.map((task) => ({ ...task })),
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(result.rejected).toBe(false);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
  });

  it('fails closed before approval when queued regeneration and its one repair both fail quality', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const invalidTask = makeBriefQualityFailureTask();
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({
        text: formatTasks([invalidTask]),
        usage: null,
      }),
    });
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const queuedMessage = {
      id: 'queued-pre-reviewed-invalid',
      text: 'include the retry behavior in the brief',
      queuedAt: new Date().toISOString(),
      phase: 'reviewing-plan' as const,
      deliveredViaNative: false,
      nativeDeliveryState: 'pending' as const,
      origin: 'user-input' as const,
    };
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('feature'),
        phase: 'reviewing-plan',
        messageQueue: [queuedMessage],
      },
    );

    const tasks = [makePassingTask()];
    const result = await runBriefsApprovalLoop({
      tasks,
      qualityValidatedTasks: tasks,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(planner.review).toHaveBeenCalledTimes(2);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rejected: false, failed: true });
    expect(result.state.phase).toBe('idle');
    expect(result.tasks).toEqual([]);
    expect(result.state.messageQueue[0]?.drainedAt).toBeUndefined();
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'queue_drained')).toHaveLength(0);
  });

  it('fails closed before approval when a fresh unvalidated brief cannot pass quality', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const invalidTask = makeBriefQualityFailureTask();
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({
        text: formatTasks([invalidTask]),
        usage: null,
      }),
    });
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await runBriefsApprovalLoop({
      tasks: [invalidTask],
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rejected: false, failed: true });
    expect(result.state.phase).toBe('idle');
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(2);
  });

  it('uses the single queued regeneration repair, then approves and drains once', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const invalidTask = makeBriefQualityFailureTask();
    const planner = makePassingPlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: formatTasks([invalidTask]), usage: null })
        .mockResolvedValueOnce({ text: REAL_TASKS_MD, usage: null }),
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const queuedMessage = {
      id: 'queued-pre-reviewed-repair',
      text: 'include the revised acceptance criteria',
      queuedAt: new Date().toISOString(),
      phase: 'reviewing-plan' as const,
      deliveredViaNative: false,
      nativeDeliveryState: 'pending' as const,
      origin: 'user-input' as const,
    };
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('feature'),
        phase: 'reviewing-plan',
        messageQueue: [queuedMessage],
      },
    );

    const tasks = [makePassingTask()];
    const result = await runBriefsApprovalLoop({
      tasks,
      qualityValidatedTasks: tasks,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(planner.review).toHaveBeenCalledTimes(2);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ rejected: false, failed: false });
    expect(result.state.phase).toBe('implementing');
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
  });

  it('rechecks changed-on-disk tasks even when the entry tasks were pre-reviewed', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const tasks = [makePassingTask()];
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const invalidTasks = [makeBriefQualityFailureTask()];
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, formatTasks(invalidTasks), 'utf8');
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await runBriefsApprovalLoop({
      tasks,
      qualityValidatedTasks: tasks,
      planner: makePassingPlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(result.rejected).toBe(true);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(1);
  });

  it('quality-gates a valid edit once and skips the unchanged approval recheck', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const task = makePassingTask();
    const tasks = [task];
    const editedTasks = [{ ...task, title: 'Edited Task' }];
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, formatTasks(editedTasks), 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await runBriefsApprovalLoop({
      tasks,
      qualityValidatedTasks: tasks,
      planner: makePassingPlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(result.rejected).toBe(false);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
  });

  it('quality-gates a valid revision once and skips the unchanged approval recheck', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const task = makePassingTask();
    const tasks = [task];
    const revisedTasks = [{ ...task, title: 'Revised Task' }];
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: formatTasks(revisedTasks), usage: null }),
    });
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', comment: 'revise the task' },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await runBriefsApprovalLoop({
      tasks,
      qualityValidatedTasks: tasks,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(result.rejected).toBe(false);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
  });

  it('runs the first approval quality gate when the pre-review option is omitted', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = sequencedApproval([{ approved: true }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await runBriefsApprovalLoop({
      tasks: [makePassingTask()],
      planner: makePassingPlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(result.rejected).toBe(false);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
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

    expect(result.cancelled).toBe(true);
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

    expect(result.cancelled).toBe(false);
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
      invokePlan: async () => completedRunnerCall('raw stdout noise'),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities,
      readPhaseOutput: (filename) => (filename === TASKS_FILE ? tasksWithUnknownSection : '# doc'),
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

    expect(result.cancelled).toBe(false);
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

    expect(result.cancelled).toBe(false);
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

    expect(result.cancelled).toBe(true);
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

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks).toHaveLength(1);
    expect(reviewPrompts).toEqual([expect.stringContaining('add scope definitions to all tasks')]);
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

    expect(result.cancelled).toBe(false);
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

    expect(result.cancelled).toBe(true);
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

    expect(result.cancelled).toBe(false);
    expect(reviewPrompts[0]).toContain('- T010: "Saved draft task" (src/saved-draft.ts)');
    expect(reviewPrompts[0]).toContain('Regenerate ONLY the flagged tasks above');
    expect(reviewPrompts[0]).toContain('Keep every other task unchanged');
  });

  it('applies queued planner input before first brief review when spec and plan gates are skipped', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const reviewPrompts: string[] = [];
    const planner = makePassingPlanner({
      plan: async () => {
        saveState(
          { projectDir, sessionId },
          {
            ...createInitialState('feature'),
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

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith('briefs', expect.stringContaining(TASKS_FILE));
    expect(reviewPrompts).toEqual([
      expect.stringContaining('make the task brief include the CLI retry case'),
    ]);
    expect(events.some((event) => event.type === 'queue_drained' && event.count === 1)).toBe(true);
    expect(result.failed ?? false).toBe(false);
  });

  it('a second consecutive approval over the same blocking report records the override and reaches implementing', async () => {
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

    const { result, projectDir, sessionId, events } = await runPhase({
      planner,
      callbacks,
      config,
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_READINESS_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(persisted.override.blockedTaskIds).toEqual(['T001']);
    expect(persisted.override.kinds).toEqual(['overflow']);
    expect(persisted.override.at).toEqual(expect.any(String));
    expect(
      events.some(
        (event) => event.type === 'warning' && event.code === 'brief_readiness_overridden',
      ),
    ).toBe(true);
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
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, editedOverflowing, 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: true });
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

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(4);
    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_READINESS_FILE);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(persisted.override.blockedTaskIds).toEqual(['T002']);
    expect(
      events.some(
        (event) => event.type === 'warning' && event.code === 'brief_readiness_overridden',
      ),
    ).toBe(true);
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
    const config = makeConfig({
      implementer: { contextLength: 200 },
      workflow: { mode: 'standard', approve: 'none' },
    });

    const { result, events } = await runPhase({ planner, callbacks, config });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(4);
    expect(
      events.some((event) => event.type === 'error' && event.code === 'brief_review_no_progress'),
    ).toBe(false);
  });

  it('does not regenerate briefs after a user edit fails quality in an active review', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const review = vi.fn();
    const planner = makePlanner({ review });
    const tasks = [makePassingTask()];
    const invalidTasks = [makeBriefQualityFailureTask()];
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, formatTasks(invalidTasks), 'utf8');
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runBriefsApprovalLoop({
      tasks,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config,
      metadata: TEST_METADATA,
    });

    expect(review).not.toHaveBeenCalled();
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(result.rejected).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(events.some((event) => event.type === 'brief_quality_failed')).toBe(true);
  });

  it('uses the existing no-progress cap when approval keeps presenting invalid briefs', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = makePlanner({ review: vi.fn() });
    const tasks = [makePassingTask()];
    const invalidTasks = formatTasks([makeBriefQualityFailureTask()]);
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementation(async () => {
        writeFileSync(tasksPath, invalidTasks, 'utf8');
        return { approved: true };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', approve: 'none' },
    });

    const result = await runBriefsApprovalLoop({
      tasks,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' },
      config,
      metadata: TEST_METADATA,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(20);
    expect(result.rejected).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(
      events.some((event) => event.type === 'error' && event.code === 'brief_review_no_progress'),
    ).toBe(true);
    expect(planner.review).not.toHaveBeenCalled();
  });

  it('an always-editing callback over an unfixable plan calls onApprovalNeeded at most the no-progress cap and ends rejected', async () => {
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

    expect(onApprovalNeeded).toHaveBeenCalledTimes(20);
    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(
      events.some((event) => event.type === 'error' && event.code === 'brief_review_no_progress'),
    ).toBe(true);
  });

  it('a readiness block reached through the edit path warns but never grants an override on the next approval', async () => {
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
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, overflowingTasks, 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValue({ approved: true });
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

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(3);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.code === 'brief_readiness_block' &&
          event.message.includes('Approve again without editing tasks.md to proceed anyway'),
      ),
    ).toBe(true);
  });
});

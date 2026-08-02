import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { BRIEF_QUALITY_FILE, sessionDir, TASKS_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { runPlanningPhase } from './run.js';
import { createPlannerBase } from '../../planners/base.js';
import type { OrchestratorCallbacks } from '../types.js';
import { taskId } from '../../../core/schemas/task.js';
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

  it('standard mode refreshes readiness and blocks approval when a brief overflows workers', async () => {
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
          event.type === 'error' &&
          event.message.includes('Task Brief approval blocked') &&
          event.message.includes('Next best action'),
      ),
    ).toBe(true);
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

  it('brief edit refreshes readiness and blocks the save when the edited tasks.md overflows workers', async () => {
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
          event.type === 'error' &&
          event.message.includes('Task Brief approval blocked') &&
          event.message.includes('Next best action'),
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
  });
});

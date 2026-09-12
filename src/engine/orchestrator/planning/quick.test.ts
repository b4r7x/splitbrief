import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../core/state/machine.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { TASKS_FILE, SPEC_FILE, sessionDir } from '../../../core/paths.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../core/schemas/task-compilation.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { runPlanningPhase } from './run.js';
import { runQuickPlanning } from './quick.js';
import type { PlanOptions, PlannerArtifactLogicalName } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import {
  makePassingTask,
  makeBriefQualityFailureTask,
  REAL_TASKS_MD,
} from '#testing/helpers/planning-phase.js';

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'quick',
} as const;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('quick-planning-test');
  dirs.push(projectDir);
  const sessionId = 'sess-quick';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function phaseResult(logicalName: PlannerArtifactLogicalName, text: string) {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `quick-test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: {
        status: 'completed',
        recordId: `quick-test-${logicalName}`,
        protocolDigest: digest,
      },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

async function runZeroTaskQuick() {
  const { projectDir, sessionId } = setupProject();
  const quickPlan = vi.fn().mockResolvedValue({
    spec: '',
    plan: '',
    tasks: [],
    usage: { inputTokens: 30, outputTokens: 15 },
    phases: [phaseResult(TASKS_FILE, '# empty')],
  });
  const { callbacks } = makeCallbacks();
  const { bus, events } = makeBusRecorder();
  const result = await runQuickPlanning({
    wctx: {
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { mode: 'quick', approve: 'none' } }),
      callbacks,
      metadata: TEST_METADATA,
      bus,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    },
    planner: makePlanner({ quickPlan }),
    state: createInitialState('feature'),
    feature: 'feature',
  });
  return { result, events, quickPlan, projectDir, sessionId };
}

describe('runQuickPlanning', () => {
  it('passes transient rewind feedback without locally starting implementation', async () => {
    const { projectDir, sessionId } = setupProject();
    const rawFeedback = 'split private quick feedback into smaller work';
    const quickPlan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [
        makeTask({
          scope: { inBounds: ['src/hello.ts'], outOfBounds: ['unrelated files'] },
          evidence: ['brief-quality.json records a passing gate'],
          typeDefs: 'type QuickTask = { file: string }',
        }),
      ],
      usage: { inputTokens: 30, outputTokens: 15 },
      phases: [phaseResult(TASKS_FILE, '# tasks')],
    });
    const planner = makePlanner({ quickPlan });
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'quick' } });
    const { bus } = makeBusRecorder();
    const state = {
      ...createInitialState('feature'),
      phase: 'planning' as const,
      rewindPending: { target: 'plan' as const, comment: '[transcript omitted]' },
    };

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        metadata: TEST_METADATA,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state,
      feature: 'feature',
      rewindPending: { target: 'plan', comment: rawFeedback },
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(quickPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: expect.stringContaining(rawFeedback),
      }),
    );
    expect(quickPlan).toHaveBeenCalledTimes(1);
    expect(result.state.rewindPending).toMatchObject({ target: 'plan' });
  });

  it('quick planning with zero tasks fails planning terminally', async () => {
    const { result, events, quickPlan } = await runZeroTaskQuick();

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
    expect(result.state.phase).toBe('idle');
    expect(result.state.tasks).toHaveLength(0);
    expect(quickPlan).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('books only the initial planner call when it returns zero tasks', async () => {
    const { result } = await runZeroTaskQuick();

    expect(result.state.tokenUsage.plannerInput).toBe(30);
    expect(result.state.tokenUsage.plannerOutput).toBe(15);
  });

  it('publishes the zero-task warning without promoting the failed attempt text', async () => {
    const { result, events, projectDir, sessionId } = await runZeroTaskQuick();

    expect(result.disposition).toBe('terminal');
    expect(existsSync(join(sessionDir(projectDir, sessionId), TASKS_FILE))).toBe(false);
    const warning = events.find(
      (event) => event.type === 'warning' && event.code === 'planner_returned_zero_tasks',
    );
    expect(warning).toMatchObject({
      category: 'planner',
      code: 'planner_returned_zero_tasks',
    });
    if (warning?.type === 'warning') {
      expect(warning.message).toContain('quick');
      expect(warning.message).toContain('no parsable Task Brief');
    }
  });

  it('emits a warning when approve level overrides quick default', async () => {
    const { projectDir, sessionId } = setupProject();
    const quickPlan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [],
      usage: { inputTokens: 30, outputTokens: 15 },
      phases: [phaseResult(TASKS_FILE, '# empty')],
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { mode: 'quick', approve: 'all' } }),
        callbacks,
        metadata: TEST_METADATA,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner: makePlanner({ quickPlan }),
      state: createInitialState('feature'),
      feature: 'feature',
    });

    const warning = events.find((event) => event.type === 'warning');
    expect(warning).toMatchObject({
      type: 'warning',
      category: 'workflow',
      code: 'approve_ignored_for_mode',
    });
    if (warning?.type === 'warning') expect(warning.message).toContain('quick');
  });

  it('asks collected questions before admission', async () => {
    const { projectDir, sessionId } = setupProject();
    const question: ClarificationQuestion = { id: 'q1', type: 'input', text: 'Module name?' };
    const quickPlan = vi.fn().mockImplementation(async (opts: PlanOptions) => {
      opts.callbacks.onQuestion?.([question]);
      return {
        spec: '',
        plan: '',
        tasks: [makePassingTask()],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [phaseResult(TASKS_FILE, REAL_TASKS_MD)],
      };
    });
    // The answer is queued, and the brief quality gate drains the queue into one
    // regeneration through planner.review before it gates.
    const planner = makePlanner({
      quickPlan,
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });
    const onQuestionAsked = vi.fn().mockResolvedValue('auth-module');
    const { callbacks } = makeCallbacks({ onQuestionAsked });
    const config = makeConfig({ workflow: { mode: 'quick' } });
    const { bus, events } = makeBusRecorder();

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        metadata: TEST_METADATA,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'researching' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
    const tasksText = readFileSync(join(sessionDir(projectDir, sessionId), TASKS_FILE), 'utf8');
    expect(tasksText).toContain('Add auth');
    const specContent = readFileSync(join(sessionDir(projectDir, sessionId), SPEC_FILE), 'utf8');
    expect(specContent).toContain('## Clarifications');
    expect(specContent).toContain('auth-module');
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();
  });

  it('all-skip still reaches ready-for-tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const question: ClarificationQuestion = { id: 'q1', type: 'input', text: 'Module name?' };
    const quickPlan = vi.fn().mockImplementation(async (opts: PlanOptions) => {
      opts.callbacks.onQuestion?.([question]);
      return {
        spec: '',
        plan: '',
        tasks: [makePassingTask()],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [phaseResult(TASKS_FILE, '# tasks')],
      };
    });
    const planner = makePlanner({ quickPlan });
    const onQuestionAsked = vi.fn().mockResolvedValue('skip');
    const { callbacks } = makeCallbacks({ onQuestionAsked });
    const config = makeConfig({ workflow: { mode: 'quick' } });
    const { bus } = makeBusRecorder();

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        metadata: TEST_METADATA,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'researching' },
      feature: 'feature',
    });

    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
  });

  it('quick planning exits in reviewing-plan with its tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask();
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [task],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [phaseResult(TASKS_FILE, '# tasks')],
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await runQuickPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { mode: 'quick', approve: 'none' } }),
        callbacks,
        metadata: TEST_METADATA,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'researching' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('tasks-ready');
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.state.tasks).toHaveLength(1);
  });

  it('returns invalid briefs without hidden repair', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makeBriefQualityFailureTask()],
        usage: { inputTokens: 50, outputTokens: 25 },
        phases: [phaseResult(TASKS_FILE, '# tasks')],
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'quick', approve: 'none' },
    });
    const initial = createInitialState('feature');
    const wctx = {
      projectDir,
      config,
      callbacks,
      metadata: TEST_METADATA,
      sessionId,
      bus,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    };

    const result = await runQuickPlanning({
      wctx,
      planner,
      state: { ...initial, phase: 'researching' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('tasks-ready');
    expect(result.state.phase).toBe('reviewing-plan');
    expect(planner.quickPlan).toHaveBeenCalledTimes(1);
    expect(result.state.tasks).toHaveLength(1);
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();
  });
});

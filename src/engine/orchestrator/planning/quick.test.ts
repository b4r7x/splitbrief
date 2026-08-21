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

    expect(result.disposition).toBe('parked');
    expect(quickPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: expect.stringContaining(rawFeedback),
      }),
    );
    expect(quickPlan).toHaveBeenCalledTimes(1);
    expect(result.state.rewindPending).toMatchObject({ target: 'plan' });
  });

  it('parks zero tasks without an automatic repair or cancellation', async () => {
    const { projectDir, sessionId } = setupProject();
    const quickPlan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [],
      usage: { inputTokens: 30, outputTokens: 15 },
      phases: [phaseResult(TASKS_FILE, '# empty')],
    });
    const planner = makePlanner({ quickPlan });
    const { callbacks } = makeCallbacks();
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
      state: createInitialState('feature'),
      feature: 'feature',
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('idle');
    expect(result.state.tasks).toHaveLength(0);
    expect(quickPlan).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
  });

  it('books only the initial planner call when it returns zero tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const quickPlan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [],
      usage: { inputTokens: 30, outputTokens: 15 },
      phases: [phaseResult(TASKS_FILE, '# empty')],
    });
    const planner = makePlanner({ quickPlan });
    const { callbacks } = makeCallbacks();
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
      state: createInitialState('feature'),
      feature: 'feature',
    });

    expect(result.disposition).toBe('parked');
    expect(quickPlan).toHaveBeenCalledTimes(1);
    expect(result.state.tokenUsage.plannerInput).toBe(30);
    expect(result.state.tokenUsage.plannerOutput).toBe(15);
  });

  it('publishes the zero-task warning without promoting the failed attempt text', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [phaseResult(TASKS_FILE, '# empty')],
      }),
    });
    const { callbacks } = makeCallbacks();
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
      state: createInitialState('feature'),
      feature: 'feature',
    });

    expect(result.disposition).toBe('parked');
    expect(existsSync(join(sessionDir(projectDir, sessionId), TASKS_FILE))).toBe(false);
    const warning = events.find(
      (event) => event.type === 'warning' && event.code === 'planner_returned_zero_tasks',
    );
    expect(warning).toMatchObject({
      category: 'planner',
      code: 'planner_returned_zero_tasks',
      transcriptSafe: true,
    });
    if (warning?.type === 'warning') {
      expect(warning.message).toContain('quick');
      expect(warning.message).toContain('no parsable Task Brief');
    }
  });

  it('emits a warning when approve level overrides quick default', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [phaseResult(TASKS_FILE, '# empty')],
      }),
    });
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'quick', approve: 'all' } });
    const { bus, events } = makeBusRecorder();

    await runPlanningPhase({
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
      state: createInitialState('feature'),
      feature: 'feature',
    });

    const warning = events.find((event) => event.type === 'warning');
    expect(warning).toMatchObject({
      type: 'warning',
      category: 'workflow',
      code: 'approve_ignored_for_mode',
      transcriptSafe: true,
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
    const planner = makePlanner({ quickPlan });
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
      state: createInitialState('feature'),
      feature: 'feature',
    });

    expect(result.disposition).toBe('parked');
    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
    expect(result.state.generation).toBeDefined();
    expect(result.state.permit ?? null).toBeNull();
    const tasksText = readFileSync(join(sessionDir(projectDir, sessionId), TASKS_FILE), 'utf8');
    expect(tasksText).toContain('Add auth');
    const specContent = readFileSync(join(sessionDir(projectDir, sessionId), SPEC_FILE), 'utf8');
    expect(specContent).toContain('## Clarifications');
    expect(specContent).toContain('auth-module');
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();
  });

  it('all-skip remains behind the shared admission boundary', async () => {
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
      state: createInitialState('feature'),
      feature: 'feature',
    });

    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('idle');
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
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('idle');
    expect(planner.quickPlan).toHaveBeenCalledTimes(1);
    expect(result.state.tasks).toHaveLength(1);
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();
  });
});

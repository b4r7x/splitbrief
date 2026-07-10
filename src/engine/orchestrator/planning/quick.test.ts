import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
import { runPlanningPhase } from './run.js';
import type { PlanOptions } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { makePassingTask } from '#testing/helpers/planning-phase.js';

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

describe('runQuickPlanning', () => {
  it('passes transient rewind feedback to quick planning and clears rewindPending', async () => {
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
      phases: [{ text: '# tasks', filename: TASKS_FILE }],
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

    expect(result.cancelled).toBe(false);
    expect(quickPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: expect.stringContaining(rawFeedback),
      }),
    );
    expect(result.state.rewindPending).toBeUndefined();
  });

  it('cancels when the planner returns zero tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [{ text: '# empty', filename: TASKS_FILE }],
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

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(result.tasks).toHaveLength(0);
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      message: expect.stringContaining('quick planner returned zero tasks'),
    });
  });

  it('emits a warning when approve level overrides quick default', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [{ text: '# empty', filename: TASKS_FILE }],
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

  it('asks collected questions before START_QUICK', async () => {
    const { projectDir, sessionId } = setupProject();
    const question: ClarificationQuestion = { id: 'q1', type: 'input', text: 'Module name?' };
    const quickPlan = vi.fn().mockImplementation(async (opts: PlanOptions) => {
      opts.callbacks.onQuestion?.([question]);
      return {
        spec: '',
        plan: '',
        tasks: [makePassingTask()],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [{ text: '# tasks', filename: TASKS_FILE }],
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

    expect(result.cancelled).toBe(false);
    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
    const specContent = readFileSync(join(sessionDir(projectDir, sessionId), SPEC_FILE), 'utf8');
    expect(specContent).toContain('## Clarifications');
    expect(specContent).toContain('auth-module');
    expect(events.find((event) => event.type === 'plan_approved')).toBeDefined();
  });

  it('all-skip proceeds to START_QUICK', async () => {
    const { projectDir, sessionId } = setupProject();
    const question: ClarificationQuestion = { id: 'q1', type: 'input', text: 'Module name?' };
    const quickPlan = vi.fn().mockImplementation(async (opts: PlanOptions) => {
      opts.callbacks.onQuestion?.([question]);
      return {
        spec: '',
        plan: '',
        tasks: [makePassingTask()],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [{ text: '# tasks', filename: TASKS_FILE }],
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
    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
  });
});

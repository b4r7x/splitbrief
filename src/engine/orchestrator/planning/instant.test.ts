import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { TaskId } from '../../../core/schemas/task.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { expectBriefQualityBlocked } from '#testing/helpers/assertions/brief-quality.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import {
  sessionDir,
  TASKS_FILE,
  SPEC_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SESSION_LOG_FILE,
} from '../../../core/paths.js';
import { runPlanningPhase } from './run.js';
import { planningError } from './errors.js';
import { createPlannerBase } from '../../planners/base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  setupProject as setupPlanningProject,
  REAL_TASKS_MD,
} from '#testing/helpers/planning-phase.js';
import type { PlannerCapabilities } from '../../planners/types.js';
import type { Planner, PlannerCallbacks, PlanResult } from '../../planners/types.js';
import type { RunnerCallContext } from '../../calls/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import {
  OwnedPlannerArtifactSchema,
  createTaskCompilationAttemptId,
} from '../../../core/schemas/task-compilation.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { zeroTaskRetryPrompt } from '../../spec/prompts/zero-task-retry.js';

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'instant',
} as const;

const SAMPLE_TASKS_MD = `---
id: T001
title: Rename foo to bar
action: modify
file: src/foo.ts
---

### Description
Rename the symbol.

### Tests
- passes tsc

### Implementation Steps
1. Rename the symbol in src/foo.ts.

### Scope
- In bounds: src/foo.ts
- Out of bounds: unrelated modules

### Evidence
- brief-quality.json shows the task brief is complete
`;

function phaseResult(
  logicalName: 'research.md' | 'spec.md' | 'plan.md' | 'tasks.md',
  text: string,
) {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: { status: 'completed', recordId: `test-${logicalName}`, protocolDigest: digest },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('instant-test');
  dirs.push(projectDir);
  const sessionId = 'sess-instant';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function readSessionLog(projectDir: string, sessionId: string): unknown[] {
  const logPath = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function instantPlanResult(overrides?: Partial<PlanResult>): PlanResult {
  return {
    spec: '',
    plan: '',
    tasks: [
      makeTask({
        id: 'T099',
        scope: { inBounds: ['src/foo.ts'], outOfBounds: ['other files'] },
        evidence: ['brief-quality.json recorded a passing gate'],
        typeDefs: 'type RenameTask = { file: string }',
      }),
    ],
    usage: { inputTokens: 30, outputTokens: 15 },
    phases: [phaseResult(TASKS_FILE, SAMPLE_TASKS_MD)],
    ...overrides,
  };
}

function invalidPlanResult(overrides?: Partial<PlanResult>): PlanResult {
  return {
    spec: '',
    plan: '',
    tasks: [
      {
        ...makeTask(),
        id: 'T-BAD' as unknown as TaskId,
        tests: [],
        implementationSteps: [],
      },
    ],
    usage: { inputTokens: 30, outputTokens: 15 },
    phases: [phaseResult(TASKS_FILE, SAMPLE_TASKS_MD)],
    ...overrides,
  };
}

async function runInstant(
  plannerOverrides?: Partial<Planner>,
  opts?: { signal?: AbortSignal | undefined },
) {
  const { projectDir, sessionId } = setupProject();
  const planner = makePlanner({
    instantPlan: vi.fn().mockResolvedValue(instantPlanResult()),
    ...plannerOverrides,
  });
  const { callbacks } = makeCallbacks();
  const config = makeConfig({ workflow: { mode: 'instant' } });
  const { bus, events } = makeBusRecorder();
  const initial = createInitialState('rename foo to bar');
  const state: WorkflowState = { ...initial, phase: 'idle' };
  const result = await runPlanningPhase({
    wctx: {
      projectDir,
      config,
      callbacks,
      metadata: TEST_METADATA,
      sessionId,
      bus,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      ...(opts?.signal !== undefined && { signal: opts.signal }),
    },
    planner,
    state,
    feature: 'rename foo to bar',
  });
  return { result, projectDir, sessionId, events, planner };
}

describe('runInstantPlanning', () => {
  it('passes transient rewind feedback to instant planning and clears rewindPending', async () => {
    const { projectDir, sessionId } = setupProject();
    const rawFeedback = 'instant private feedback for the next task list';
    const instantPlan = vi.fn().mockResolvedValue(instantPlanResult());
    const planner = makePlanner({ instantPlan });
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const { bus } = makeBusRecorder();
    const state: WorkflowState = {
      ...createInitialState('rename foo to bar'),
      phase: 'planning',
      rewindPending: { target: 'plan', comment: '[transcript omitted]' },
    };

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
      state,
      feature: 'rename foo to bar',
      rewindPending: { target: 'plan', comment: rawFeedback },
    });

    expect(result.disposition).toBe('parked');
    expect(instantPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: expect.stringContaining(rawFeedback),
      }),
    );
    expect(result.state.rewindPending).toBeUndefined();
  });

  it('runs the nominal instant lifecycle without artifact approval', async () => {
    const onApprovalNeeded = async () => {
      throw new Error('instant mode should not request artifact approval');
    };
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      instantPlan: vi.fn().mockResolvedValue(instantPlanResult()),
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const { bus, events } = makeBusRecorder();
    const initial = createInitialState('rename foo to bar');
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
      feature: 'rename foo to bar',
    });

    const dir = sessionDir(projectDir, sessionId);
    expect(existsSync(join(dir, TASKS_FILE))).toBe(true);
    expect(readFileSync(join(dir, TASKS_FILE), 'utf-8')).toContain('Rename foo to bar');
    expect(existsSync(join(dir, SPEC_FILE))).toBe(false);
    expect(existsSync(join(dir, PLAN_FILE))).toBe(false);
    expect(existsSync(join(dir, RESEARCH_FILE))).toBe(false);

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('idle');
    expect(result.state.tasks).toHaveLength(1);
    expect(result.state.tasks[0]?.id).toBe('T099');
    expect(result.state.generation).toBeDefined();
    expect(result.state.generation?.programId).toBeNull();
    expect(result.state.permit ?? null).toBeNull();

    const implementingRunning = events.find(
      (e) => e.type === 'planner_status' && e.status === 'running' && e.phase === 'implementing',
    );
    expect(implementingRunning).toBeUndefined();

    const modeResolved = events.find((e) => e.type === 'mode_resolved');
    const instantReceived = events.find((e) => e.type === 'instant_plan_received');
    expect(modeResolved).toBeDefined();
    expect(modeResolved && 'mode' in modeResolved ? modeResolved.mode : null).toBe('instant');
    expect(instantReceived).toBeDefined();
    expect(instantReceived && 'taskCount' in instantReceived ? instantReceived.taskCount : 0).toBe(
      1,
    );
  });

  it('falls back to quickPlan when instantPlan is not provided', async () => {
    const quickPlan = vi.fn().mockResolvedValue(instantPlanResult());
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({ quickPlan });
    delete (planner as Partial<Planner>).instantPlan;
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const initial = createInitialState('feature');
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
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });
    expect(result.disposition).toBe('parked');
  });

  it('passes the workflow signal to instantPlan callbacks', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    await runInstant(
      {
        instantPlan: async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          capturedSignal = callbacks.signal;
          return instantPlanResult();
        },
      },
      { signal: controller.signal },
    );

    expect(capturedSignal).toBe(controller.signal);
  });

  it('passes the workflow signal to the quickPlan fallback callbacks', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const quickPlan = vi
      .fn()
      .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        capturedSignal = callbacks.signal;
        return instantPlanResult();
      });
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({ quickPlan });
    delete (planner as Partial<Planner>).instantPlan;
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const initial = createInitialState('feature');

    await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        signal: controller.signal,
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(capturedSignal).toBe(controller.signal);
  });

  it('projects instant planner runner-call events onto the workflow bus', async () => {
    const startedAt = Date.now();
    const call: RunnerCallContext = {
      callId: 'instant-call-test',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'instant-planner',
    };
    const { events } = await runInstant({
      instantPlan: async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onCallEvent?.({ type: 'call_started', ts: startedAt, ...call });
        callbacks.onCallEvent?.({
          type: 'call_completed',
          ts: startedAt + 1,
          ...call,
          status: 'completed',
          error: null,
          partial: false,
          startedAt,
          endedAt: startedAt + 1,
          durationMs: 1,
          usage: null,
          nativeSessionId: null,
        });
        return instantPlanResult();
      },
    });

    expect(
      events.filter((event) => event.type.startsWith('runner_call_')).map((event) => event.type),
    ).toEqual(['runner_call_started', 'runner_call_completed', 'runner_call_activity']);
    expect(events.find((event) => event.type === 'runner_call_completed')).toMatchObject({
      callId: 'instant-call-test',
      role: 'planner',
    });
    expect(events.find((event) => event.type === 'runner_call_activity')).toMatchObject({
      callId: 'instant-call-test',
      role: 'planner',
      stage: 'completed',
      kind: 'text',
    });
  });

  it('cancels when planner returns zero tasks', async () => {
    const { result, events } = await runInstant({
      instantPlan: vi
        .fn()
        .mockResolvedValue(
          instantPlanResult({ tasks: [], phases: [phaseResult(TASKS_FILE, '# empty')] }),
        ),
    });
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
    expect(result.state.phase).toBe('idle');
    expect(result.state.tasks).toHaveLength(0);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent && 'message' in errorEvent ? errorEvent.message : null).toBe(
      'Planning failed: instant planner returned zero tasks; cannot proceed',
    );
  });

  it('retries the zero-task single call exactly once before failing without promoting its text', async () => {
    const instantPlan = vi
      .fn()
      .mockResolvedValue(
        instantPlanResult({ tasks: [], phases: [phaseResult(TASKS_FILE, '# empty')] }),
      );
    const { result, projectDir, sessionId, events } = await runInstant({ instantPlan });

    expect(instantPlan).toHaveBeenCalledTimes(2);
    expect(result.disposition).toBe('terminal');
    expect(existsSync(join(sessionDir(projectDir, sessionId), TASKS_FILE))).toBe(false);
    const warning = events.find(
      (e) => e.type === 'warning' && 'code' in e && e.code === 'planner_returned_zero_tasks',
    );
    expect(warning).toMatchObject({
      category: 'planner',
      code: 'planner_returned_zero_tasks',
      transcriptSafe: true,
    });
    if (warning && 'message' in warning) {
      expect(warning.message).toContain('instant');
      expect(warning.message).toContain('no parsable Task Brief');
    }
  });

  it('continues normally when the retry returns tasks', async () => {
    const instantPlan = vi
      .fn()
      .mockResolvedValueOnce(
        instantPlanResult({ tasks: [], phases: [phaseResult(TASKS_FILE, '# empty')] }),
      )
      .mockResolvedValueOnce(instantPlanResult());
    const { result, events } = await runInstant({ instantPlan });

    expect(instantPlan).toHaveBeenCalledTimes(2);
    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('idle');
    expect(result.state.tasks).toHaveLength(1);
    expect(events.find((e) => e.type === 'warning')).toBeUndefined();
  });

  it('sends a corrective prompt instead of repeating the first one on the zero-task retry', async () => {
    const prompts: string[] = [];
    const instantPlan = vi.fn().mockImplementation(async ({ feature }: { feature: string }) => {
      prompts.push(feature);
      return prompts.length === 1
        ? instantPlanResult({ tasks: [], phases: [phaseResult(TASKS_FILE, '# empty')] })
        : instantPlanResult();
    });
    const { result } = await runInstant({ instantPlan });

    expect(result.disposition).toBe('parked');
    expect(prompts[0]).toContain('rename foo to bar');
    expect(prompts[1]).toBe(zeroTaskRetryPrompt('rename foo to bar', []));
  });

  it('books the planner tokens of both calls of a zero-task retry', async () => {
    const instantPlan = vi
      .fn()
      .mockResolvedValueOnce(
        instantPlanResult({
          tasks: [],
          usage: { inputTokens: 30, outputTokens: 15 },
          phases: [phaseResult(TASKS_FILE, '# empty')],
        }),
      )
      .mockResolvedValueOnce(instantPlanResult({ usage: { inputTokens: 12, outputTokens: 7 } }));
    const { result } = await runInstant({ instantPlan });

    expect(result.disposition).toBe('parked');
    expect(result.state.tokenUsage.plannerInput).toBe(42);
    expect(result.state.tokenUsage.plannerOutput).toBe(22);
  });

  it('persists nothing when the terminal retry produces no phases', async () => {
    const instantPlan = vi
      .fn()
      .mockResolvedValueOnce(
        instantPlanResult({
          tasks: [],
          phases: [
            phaseResult(TASKS_FILE, '# first attempt text'),
            phaseResult(SPEC_FILE, '# first attempt spec'),
          ],
        }),
      )
      .mockResolvedValueOnce(instantPlanResult({ tasks: [], phases: [] }));
    const { result, projectDir, sessionId } = await runInstant({ instantPlan });

    expect(instantPlan).toHaveBeenCalledTimes(2);
    expect(result.disposition).toBe('terminal');
    const dir = sessionDir(projectDir, sessionId);
    expect(existsSync(join(dir, TASKS_FILE))).toBe(false);
    expect(existsSync(join(dir, SPEC_FILE))).toBe(false);
  });

  it('persists only the terminal retry phases when the first call also produced a filename', async () => {
    const instantPlan = vi
      .fn()
      .mockResolvedValueOnce(
        instantPlanResult({
          tasks: [],
          phases: [
            phaseResult(TASKS_FILE, '# first tasks'),
            phaseResult(SPEC_FILE, '# first spec'),
          ],
        }),
      )
      .mockResolvedValueOnce(
        instantPlanResult({ phases: [phaseResult(TASKS_FILE, SAMPLE_TASKS_MD)] }),
      );
    const { result, projectDir, sessionId } = await runInstant({ instantPlan });

    expect(instantPlan).toHaveBeenCalledTimes(2);
    expect(result.disposition).toBe('parked');
    const dir = sessionDir(projectDir, sessionId);
    const tasksText = readFileSync(join(dir, TASKS_FILE), 'utf-8');
    expect(tasksText).toContain('Rename foo to bar');
    expect(tasksText).not.toContain('# first tasks');
    expect(existsSync(join(dir, SPEC_FILE))).toBe(false);
  });

  it('performs exactly one planner call when the first call returns tasks', async () => {
    const instantPlan = vi.fn().mockResolvedValue(instantPlanResult());
    await runInstant({ instantPlan });

    expect(instantPlan).toHaveBeenCalledTimes(1);
  });

  it('surfaces a kind-tagged error when the planner returns zero tasks', () => {
    const err = planningError.zeroTasks('instant');
    expect(err.kind).toBe('planning-zero-tasks');
    expect(err.message).toBe('instant planner returned zero tasks; cannot proceed');
    expect(err.data).toEqual({ planner: 'instant' });
  });

  it('emits a warning when approve level overrides instant default', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({ instantPlan: vi.fn().mockResolvedValue(instantPlanResult()) });
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'instant', approve: 'all' } });
    const { bus, events } = makeBusRecorder();
    const initial = createInitialState('feature');
    await runPlanningPhase({
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
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    if (warning && 'message' in warning) {
      expect(warning.message).toContain('instant');
      expect(warning.message).toContain('all');
    }
  });

  it('blocks invalid briefs before implementing and writes the brief-quality report', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      instantPlan: vi.fn().mockResolvedValue(invalidPlanResult()),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({ workflow: { mode: 'instant' } });
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

    expectBriefQualityBlocked({ result, ref: { projectDir, sessionId }, events });
  });

  it('strips markers from published text but keeps raw transcript', async () => {
    const marker = '<!-- Q:{"id":"q1","type":"input","text":"Name?"} -->';
    const { projectDir, sessionId, events } = await runInstant({
      instantPlan: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callbacks.onOutput('before ');
          callbacks.onOutput(marker);
          callbacks.onOutput(' after');
          return instantPlanResult();
        }),
    });

    const publishedText = events
      .filter((e) => e.type === 'planner_text')
      .map((e) => e.text)
      .join('');
    expect(publishedText).not.toContain('<!--');
    expect(publishedText).toContain('before');
    expect(publishedText).toContain('after');

    expect(readSessionLog(projectDir, sessionId)).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        text: expect.stringContaining(marker),
      }),
    );
  });

  it('asks collected questions before parking the owner handoff', async () => {
    const { projectDir, sessionId } = setupProject();
    const question: ClarificationQuestion = { id: 'q1', type: 'input', text: 'Module name?' };
    const planner = makePlanner({
      instantPlan: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callbacks.onQuestion?.([question]);
          return instantPlanResult();
        }),
    });
    const onQuestionAsked = vi.fn().mockResolvedValue('auth-module');
    const { callbacks } = makeCallbacks({ onQuestionAsked });
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const initial = createInitialState('feature');

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
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('parked');
    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
    const specContent = readFileSync(join(sessionDir(projectDir, sessionId), SPEC_FILE), 'utf-8');
    expect(specContent).toContain('## Clarifications');
    expect(specContent).toContain('auth-module');
  });

  it('deduplicates IDs across the zero-task retry before applying the question cap', async () => {
    const { projectDir, sessionId } = setupProject();
    const firstQuestion: ClarificationQuestion = {
      id: 'q1',
      type: 'input',
      text: 'First wording',
    };
    const duplicateQuestion: ClarificationQuestion = {
      id: 'q1',
      type: 'input',
      text: 'Later wording must not replace the first question',
    };
    const distinctQuestions: ClarificationQuestion[] = ['q2', 'q3', 'q4', 'q5', 'q6'].map((id) => ({
      id,
      type: 'input',
      text: id,
    }));
    const instantPlan = vi
      .fn()
      .mockImplementationOnce(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onQuestion?.([firstQuestion, firstQuestion]);
        return instantPlanResult({ tasks: [] });
      })
      .mockImplementationOnce(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onQuestion?.([duplicateQuestion, ...distinctQuestions]);
        return instantPlanResult();
      });
    const planner = makePlanner({ instantPlan });
    const onQuestionAsked = vi.fn().mockResolvedValue('answer');
    const { callbacks } = makeCallbacks({ onQuestionAsked });
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const initial = createInitialState('feature');

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
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('parked');
    expect(onQuestionAsked.mock.calls).toEqual([
      [firstQuestion, 1, 5],
      [distinctQuestions[0], 2, 5],
      [distinctQuestions[1], 3, 5],
      [distinctQuestions[2], 4, 5],
      [distinctQuestions[3], 5, 5],
    ]);
  });

  it('all-skip parks without entering implementation', async () => {
    const { projectDir, sessionId } = setupProject();
    const question: ClarificationQuestion = { id: 'q1', type: 'input', text: 'Module name?' };
    const planner = makePlanner({
      instantPlan: vi
        .fn()
        .mockImplementation(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
          callbacks.onQuestion?.([question]);
          return instantPlanResult();
        }),
    });
    const onQuestionAsked = vi.fn().mockResolvedValue('skip');
    const { callbacks } = makeCallbacks({ onQuestionAsked });
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const initial = createInitialState('feature');

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
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('idle');
  });
});

const plannerBaseCapabilities: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: false,
};

function completedPlannerBaseRunnerCall(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

describe('createPlannerBase — unknown Task Brief section warning (F-429 / N399)', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  const tasksWithUnknownSection = `${REAL_TASKS_MD}
### Future Considerations

- this heading is outside the canonical grammar and will be dropped
`;

  it('emits a warning event when planner-generated briefs contain an unknown ### section', async () => {
    const { projectDir, sessionId } = setupPlanningProject(dirs);
    const planner = createPlannerBase({
      invokePlan: async () => completedPlannerBaseRunnerCall(tasksWithUnknownSection),
      invokeEscalate: async () => completedPlannerBaseRunnerCall(''),
      isAvailable: async () => true,
      capabilities: plannerBaseCapabilities,
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const initial = createInitialState('add auth');

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config: makeConfig({ workflow: { mode: 'instant' } }),
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        drainPendingAttachments: () => [],
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'add auth',
    });

    expect(result.disposition).toBe('parked');
    const warning = events.find(
      (e) => e.type === 'warning' && e.message.includes('Future Considerations'),
    );
    expect(warning).toBeDefined();
  });
});

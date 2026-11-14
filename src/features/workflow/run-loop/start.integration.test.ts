import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { createProcessScope } from '../../../lib/process/registry.js';
import { installDiagnosticSink } from '../../../lib/warn.js';
import { configStore } from '../../../stores/project/config.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import type { PrepareExecutionFn, RunWorkflowFn } from '../hooks/use-run-loop.js';
import {
  plainAnswer,
  type QuestionAnswer,
  type UseInputModeResult,
} from '../hooks/use-input-mode.js';
import { clearAllHandlers } from '../run-requests/registry.js';
import { runTuiWorkflow } from './start.js';

type EngineOptions = Parameters<RunWorkflowFn>[0];

interface EngineContext {
  steps: string[];
  abortedRef: { current: boolean };
}

interface StartOptions {
  resumeCause?: 'seat-change' | undefined;
  /** The answers of the recovery panel, in order: each question it asks is a step. */
  answers?: QuestionAnswer[] | undefined;
  steps?: string[] | undefined;
  /** A run this re-entry continues: saved where the loop reads it, and prepared as a resume. */
  resumeState?: WorkflowState | undefined;
}

function awaitAbort(options: EngineOptions): Promise<void> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) resolve();
    else options.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

describe('runTuiWorkflow', () => {
  let projectDir: string;
  let releaseSink: () => void;

  beforeEach(() => {
    projectDir = createTempDir('run-tui-workflow-');
    resetAllStores();
    configStore.__testReset({ projectDir });
    clearAllHandlers();
    releaseSink = installDiagnosticSink(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    releaseSink();
    clearAllHandlers();
    resetAllStores();
    cleanupTempDir(projectDir);
  });

  /**
   * One fresh run with a fake engine, a fake preparation, a recovery panel that takes `answers`,
   * and a settle. Each of them records its step in `steps`.
   */
  function start(
    engine: (options: EngineOptions, context: EngineContext) => Promise<void>,
    { resumeCause, answers = [], steps = [], resumeState }: StartOptions = {},
  ) {
    ensureSessionDir(projectDir, 'tui-run');
    if (resumeState !== undefined) saveState({ projectDir, sessionId: 'tui-run' }, resumeState);
    const prepared = makePreparedExecution({
      projectDir,
      sessionId: 'tui-run',
      feature: 'tui run',
      config: makeConfig(),
      resumeState,
    });
    const controller = new AbortController();
    const abortedRef = { current: false };
    const runWorkflow = vi.fn<RunWorkflowFn>(async (options) => {
      steps.push('engine');
      await engine(options, { steps, abortedRef });
      return makeSummary();
    });
    const prepareExecution = vi.fn<PrepareExecutionFn>(async (input) => {
      steps.push('prepare');
      return {
        kind: 'prepared',
        execution: makePreparedExecution({
          projectDir,
          sessionId: 'tui-run',
          feature: input.feature,
          config: input.effectiveConfig,
          purpose: input.policy.purpose,
          resumeState: input.resumeState,
        }),
      };
    });
    const inputMode: UseInputModeResult = {
      mode: 'normal',
      hint: '',
      questionEpoch: 0,
      setReviewMode: vi.fn(),
      setQuestionMode: vi.fn(async () => {
        steps.push('ask');
        const answer = answers.shift();
        if (answer === undefined)
          throw new Error('the panel asked a question the test does not answer');
        return answer;
      }),
      resolve: vi.fn(),
      resetMode: vi.fn(),
    };
    const settleRun = vi.fn(async (ref: typeof prepared.session.ref, handoff: boolean) => {
      steps.push(`settle handoff=${handoff}`);
      return makeRunRecord({ ref });
    });
    const setInlineResume = vi.fn();
    const run = runTuiWorkflow({
      prepared,
      steer: plainUserMessage('carry on'),
      resumeCause,
      selectedSkills: undefined,
      inputMode,
      continuation: {
        runId: 0,
        inlineResume: undefined,
        setInlineResume,
        handleResume: vi.fn(),
      },
      runWorkflow,
      prepareExecution,
      continueAtRest: undefined,
      abortedRef,
      retentionNoticeHandled: { current: true },
      controller,
      scope: createProcessScope(),
      settleRun,
    });
    return {
      run,
      steps,
      prepared,
      controller,
      runWorkflow,
      prepareExecution,
      settleRun,
      setInlineResume,
    };
  }

  it('hands a run that returns at rest to the screen once, after the engine', async () => {
    const loop = start(async () => {});

    await loop.run;

    expect(loop.steps).toEqual(['engine', 'settle handoff=true']);
    expect(loop.settleRun).toHaveBeenCalledWith(loop.prepared.session.ref, true);
    expect(loop.runWorkflow.mock.calls[0]?.[0]).toMatchObject({
      prepared: loop.prepared,
      steer: plainUserMessage('carry on'),
      savedState: undefined,
    });
    expect(loop.prepareExecution).not.toHaveBeenCalled();
  });

  it('hands a run that a stop aborted to the screen once, after the engine returns', async () => {
    let engineWaits: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      engineWaits = resolve;
    });
    const loop = start(async (options, { steps }) => {
      engineWaits();
      await awaitAbort(options);
      steps.push('engine saw the abort');
    });

    await waiting;
    loop.controller.abort();
    await loop.run;

    expect(loop.steps).toEqual(['engine', 'engine saw the abort', 'settle handoff=true']);
    expect(loop.runWorkflow).toHaveBeenCalledTimes(1);
  });

  it('hands nothing to the screen when the screen left the run before the engine returned', async () => {
    const loop = start(async (_options, { abortedRef }) => {
      abortedRef.current = true;
    });

    await loop.run;

    expect(loop.steps).toEqual(['engine']);
    expect(loop.settleRun).not.toHaveBeenCalled();
  });

  function haltedOnT001(): WorkflowState {
    return makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
      ...RUN_CREW,
      pendingRecovery: makeRecoveryIssue(),
    });
  }

  /** The engine's first `count` passes halt on T001 and save the halt where the loop reads it. */
  function haltPasses(count = 1): (options: EngineOptions) => Promise<void> {
    let passes = 0;
    return async (options) => {
      passes += 1;
      if (passes > count) return;
      saveState(options.prepared.session.ref, haltedOnT001());
    };
  }

  function passInputs(loop: ReturnType<typeof start>) {
    return loop.runWorkflow.mock.calls.map(([options]) => ({
      steer: options.steer?.text,
      resumeCause: options.resumeCause,
    }));
  }

  it('runs a pass, the halt panel and the next pass in that order, and spends the steer and the resume cause on the first pass', async () => {
    const loop = start(haltPasses(), {
      resumeCause: 'seat-change',
      answers: [{ ...plainAnswer('retry'), row: true }],
    });

    await loop.run;

    expect(loop.steps).toEqual(['engine', 'ask', 'prepare', 'engine', 'settle handoff=true']);
    expect(passInputs(loop)).toEqual([
      { steer: 'carry on', resumeCause: 'seat-change' },
      { steer: undefined, resumeCause: undefined },
    ]);
    expect(loop.runWorkflow.mock.calls[1]?.[0].savedState?.pendingRecovery).toBeUndefined();
    // The pass that halted published the halt's prompt, so the panel does not publish it again.
    expect(eventsStore.get().events.filter((event) => event.type === 'recovery_prompted')).toEqual(
      [],
    );
  });

  it('hands the words typed at the halt panel to the pass after it', async () => {
    const loop = start(haltPasses(), { answers: [plainAnswer('add a default')] });

    await loop.run;

    expect(loop.steps).toEqual(['engine', 'ask', 'prepare', 'engine', 'settle handoff=true']);
    expect(passInputs(loop)).toEqual([
      { steer: 'carry on', resumeCause: undefined },
      { steer: 'add a default', resumeCause: undefined },
    ]);
  });

  it('asks the panel first on a re-entry at a halt, and gives the re-entry steer and resume cause to the pass after it when the answer takes no words', async () => {
    const loop = start(async () => {}, {
      resumeCause: 'seat-change',
      resumeState: haltedOnT001(),
      answers: [{ ...plainAnswer('s'), row: true }],
    });

    await loop.run;

    expect(loop.steps).toEqual(['ask', 'engine', 'settle handoff=true']);
    expect(passInputs(loop)).toEqual([{ steer: 'carry on', resumeCause: 'seat-change' }]);
    expect(loop.runWorkflow.mock.calls[0]?.[0].savedState?.tasks[0]?.status).toBe('skipped');
  });

  it('saves each halt for the next re-entry under the preparation it started with, also after the session is admitted again', async () => {
    const retry = { ...plainAnswer('retry'), row: true as const };
    const loop = start(haltPasses(2), { answers: [retry, retry] });

    await loop.run;

    expect(loop.steps).toEqual([
      'engine',
      'ask',
      'prepare',
      'engine',
      'ask',
      'engine',
      'settle handoff=true',
    ]);
    expect(loop.runWorkflow.mock.calls[1]?.[0].prepared).not.toBe(loop.prepared);
    expect(loop.setInlineResume.mock.calls.length).toBe(4);
    for (const [saved] of loop.setInlineResume.mock.calls)
      expect(saved.prepared).toBe(loop.prepared);
  });

  it('hands a run that a stop aborted in its second pass to the screen once, after that pass, and then stops following the config', async () => {
    const steps: string[] = [];
    const subscribe = configStore.subscribe;
    let subscriptions = 0;
    vi.spyOn(configStore, 'subscribe').mockImplementation((listener) => {
      const off = subscribe(listener);
      subscriptions += 1;
      const subscription = subscriptions;
      return () => {
        steps.push(`stop following config ${subscription}`);
        off();
      };
    });
    const halts = haltPasses();
    let passes = 0;
    let secondPassWaits: () => void = () => {};
    const secondPass = new Promise<void>((resolve) => {
      secondPassWaits = resolve;
    });
    const loop = start(
      async (options) => {
        passes += 1;
        await halts(options);
        if (passes < 2) return;
        secondPassWaits();
        await awaitAbort(options);
        steps.push('engine saw the abort');
      },
      { answers: [{ ...plainAnswer('retry'), row: true }], steps },
    );

    await secondPass;
    loop.controller.abort();
    await loop.run;

    expect(loop.steps).toEqual([
      'engine',
      'ask',
      'stop following config 2',
      'prepare',
      'engine',
      'engine saw the abort',
      'settle handoff=true',
      'stop following config 1',
    ]);
    expect(loop.settleRun).toHaveBeenCalledTimes(1);
  });
});

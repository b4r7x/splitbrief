import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { createProcessScope } from '../../../lib/process/registry.js';
import { installDiagnosticSink } from '../../../lib/warn.js';
import { configStore } from '../../../stores/project/config.js';
import type { PrepareExecutionFn, RunWorkflowFn } from '../hooks/use-run-loop.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import { clearAllHandlers } from '../run-requests/handlers.js';
import { runTuiWorkflow } from './start.js';

type EngineOptions = Parameters<RunWorkflowFn>[0];

interface EngineContext {
  steps: string[];
  abortedRef: { current: boolean };
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
    releaseSink();
    clearAllHandlers();
    resetAllStores();
    cleanupTempDir(projectDir);
  });

  /** One fresh run with a fake engine and a settle that records each hand-off in `steps`. */
  function start(engine: (options: EngineOptions, context: EngineContext) => Promise<void>) {
    const steps: string[] = [];
    const prepared = makePreparedExecution({
      projectDir,
      sessionId: 'tui-run',
      feature: 'tui run',
      config: makeConfig(),
    });
    const controller = new AbortController();
    const abortedRef = { current: false };
    const runWorkflow = vi.fn<RunWorkflowFn>(async (options) => {
      steps.push('engine');
      await engine(options, { steps, abortedRef });
      return makeSummary();
    });
    const prepareExecution = vi.fn<PrepareExecutionFn>();
    const inputMode: UseInputModeResult = {
      mode: 'normal',
      hint: '',
      questionEpoch: 0,
      setReviewMode: vi.fn(),
      setQuestionMode: vi.fn(),
      resolve: vi.fn(),
      resetMode: vi.fn(),
    };
    const settleRun = vi.fn(async (ref: typeof prepared.session.ref, handoff: boolean) => {
      steps.push(`settle handoff=${handoff}`);
      return makeRunRecord({ ref });
    });
    const run = runTuiWorkflow({
      prepared,
      steer: plainUserMessage('carry on'),
      resumeCause: undefined,
      selectedSkills: undefined,
      inputMode,
      continuation: {
        runId: 0,
        inlineResume: undefined,
        setInlineResume: vi.fn(),
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
    return { run, steps, prepared, controller, runWorkflow, prepareExecution, settleRun };
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
});

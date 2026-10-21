import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ImplementerResult } from '../../implementers/types.js';
import type { RunImplementationResult } from './run-implementation.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { extractedCodeApprovalRaceError } from '../../implementers/pipeline/extracted-code.js';
import { handleFailedImplementation } from './implementation-failure.js';
import { runnerCallOutcome } from '../../implementers/pipeline/call-result.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { writeConfig } from '../../../core/config/load/io.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { CliImplementerConfig } from '../../../core/schemas/implementer-config.js';
import type { Implementer } from '../../implementers/types.js';
import { createCliImplementer } from '../../implementers/cli.js';
import { createShellImplementer } from '../../implementers/shell.js';
import { createApiImplementer } from '../../implementers/api.js';
import { runTaskLoop } from './loop.js';
import { formatRecoveryPrompt } from '../../../features/workflow/recovery-prompt.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { withLocalCatalog } from '#testing/helpers/faux/local-catalog.js';

afterEach(cleanupTaskProjects);

function implState(implResult: ImplementerResult): RunImplementationResult {
  return {
    state: implementingState([makeTask()]),
    implResult,
    workspace: {
      projectDir: '/unused',
      sandboxEnv: {},
      snapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      targetBaseline: undefined,
      changedFiles: async () => [],
      cleanup: () => {},
      revert: async () => {},
    },
    preApplyApprovalDenied: false,
    preApplyApprovedFiles: [],
  };
}

describe('handleFailedImplementation — runner defects halt before the ladder', () => {
  it('unknown flag does not consume a retry', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ implementer, bus });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-recipe-invalid',
        error: 'error: unknown flag --print-timeout',
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery).toMatchObject({
      reason: 'implementer-recipe-invalid',
      taskId: 'T001',
      attempts: 1,
      maxAttempts: 8,
    });
    // The halt counts the one call the tool refused, on the brief's lineage.
    expect(next.pendingRecovery?.details).toContain('Attempts: 1/8');
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
  });

  it('an implementer that left its isolation directory halts on the evidence', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ implementer, bus });
    const evidence = 'searched ~ with run_command: find ~ -name x';

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-left-isolation',
        error: evidence,
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery).toMatchObject({
      reason: 'implementer-left-isolation',
      taskId: 'T001',
      message: `T001 left the isolation directory · Ollama ${evidence}`,
      recommendedAction: 'retry-same-worker',
    });
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: `T001 left the isolation directory · Ollama ${evidence}`,
      }),
    );
  });

  it('a checkout whose git state changed during the call halts without blaming the tool', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ implementer, bus });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'checkout-changed',
        error: 'branch escaped',
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery).toMatchObject({
      reason: 'checkout-changed',
      taskId: 'T001',
      message: 'Repository changed under T001 · branch escaped',
      recommendedAction: 'retry-same-worker',
    });
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'Repository changed under T001 · branch escaped',
      }),
    );
  });

  it('a model the tool does not list halts with the same reason', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({ implementer });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'missing-model',
        error: 'model not found',
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery?.reason).toBe('implementer-recipe-invalid');
  });

  it('a brief that already timed out twice halts on its own reason', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({ implementer });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'runner-timeout-repeated',
        error: 'implementer timed out',
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery?.reason).toBe('runner-timeout-repeated');
  });
});

// Recorded on 2026-10-05: the `runner_call_error` of opencode with `deepseek/deepseek-flash` on a
// spent DeepSeek account, which the run retried once and then consulted the planner on.
const OPENCODE_DEEPSEEK_BALANCE =
  'provider.quota: Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)';

describe('handleFailedImplementation — an account the provider refuses is a seat-down halt', () => {
  async function haltOn(message: string) {
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode', 'claude-code']));
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      bus,
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        validation: { endChecks: false, testCommand: 'noop' },
      }),
    });
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: { code: 'opencode-error', message },
        backendKind: 'cli',
      }),
    );

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        error: message,
        ...(outcome.state !== 'success' && { outcome: outcome.state }),
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });
    return { next, events, implementer };
  }

  it('halts on the spent balance at once: no retry, no consult, the seat switch first', async () => {
    const { next, events, implementer } = await haltOn(OPENCODE_DEEPSEEK_BALANCE);

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
    expect(events.filter((e) => e.type === 'task_escalating')).toEqual([]);
    expect(events.filter((e) => e.type === 'consult_answered')).toEqual([]);
    expect(next.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      taskId: 'T001',
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    expect(next.pendingRecovery?.resetAt).toBeUndefined();
    expect(next.pendingRecovery?.availableActions).toContain('end-run');
    const row = events.find((e) => e.type === 'error');
    expect(row?.type === 'error' && row.message).toContain(OPENCODE_DEEPSEEK_BALANCE);
    expect(row?.type === 'error' && row.message).toContain('Add credit or change the BUILD tool');
  });

  it('halts a refused login at once and offers the seat switch beside it', async () => {
    const { next, events, implementer } = await haltOn('HTTP 403 Forbidden');

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'consult_answered')).toEqual([]);
    expect(next.pendingRecovery).toMatchObject({
      reason: 'runner-unauthenticated',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    expect(next.pendingRecovery?.availableActions).toEqual(
      expect.arrayContaining(['switch-seat', 'end-run']),
    );
    const row = events.find((e) => e.type === 'error');
    expect(row?.type === 'error' && row.message).toContain('HTTP 403 Forbidden');
  });
});

describe('handleFailedImplementation — a seat refused on the retry counts both calls', () => {
  it('states the retry as the second attempt on the lineage', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        outcome: 'usage-limit',
        error: OPENCODE_DEEPSEEK_BALANCE,
      }),
    });
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        validation: { endChecks: false, testCommand: 'noop' },
      }),
    });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({ success: false, output: '', error: 'type error in src/a.ts' }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(next.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      attempts: 2,
      maxAttempts: 8,
    });
    expect(next.pendingRecovery?.details).toContain('Attempts: 2/8');
  });
});

describe('handleFailedImplementation — the automatic seat switch intent', () => {
  async function haltWith(state: WorkflowState) {
    const { projectDir, sessionId } = setupProject();
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'opencode',
        model: 'deepseek/deepseek-flash',
        fallback: { tool: 'claude-code' },
      },
      validation: { endChecks: false, testCommand: 'noop' },
    });
    writeConfig(projectDir, config);
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode', 'claude-code']));
    const task = makeTask({ id: 'T001' });
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      bus,
      config,
    });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        error: OPENCODE_DEEPSEEK_BALANCE,
        outcome: 'usage-limit',
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });
    return { next, events };
  }

  it('carries the fallback and config hash when the seat can move itself', async () => {
    const { next, events } = await haltWith(implementingState([makeTask({ id: 'T001' })]));

    const auto = next.pendingRecovery?.switchSeat?.auto;
    expect(auto?.candidate).toEqual({ tool: 'claude-code' });
    expect(auto?.configRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(events.filter((event) => event.type === 'error').map((event) => event.message)).toEqual([
      'Balance spent on deepseek (OpenCode CLI)',
    ]);
    expect(next.pendingRecovery?.message).toContain('Add credit or change the BUILD tool');
  });

  it('offers no automatic switch when this run already switched the seat', async () => {
    const state: WorkflowState = {
      ...implementingState([makeTask({ id: 'T001' })]),
      seatSwitches: [
        {
          seat: 'build',
          from: 'opencode',
          to: 'claude-code',
          cause: 'runner-usage-limit',
          auto: true,
          configRevision: 'abc',
          ts: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    const { next, events } = await haltWith(state);

    expect(next.pendingRecovery?.switchSeat?.auto).toBeUndefined();
    expect(next.pendingRecovery?.switchSeat?.candidates).toEqual([{ tool: 'claude-code' }]);
    expect(events.find((event) => event.type === 'error')?.message).toContain(
      'Add credit or change the BUILD tool',
    );
  });
});

describe('handleFailedImplementation — a stop with a hand-back is consulted', () => {
  it('ends the local rung on a no-change retry and asks the planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: 'I could not find the prop.',
        outcome: 'no-staged-change',
        error: 'exited without changing any files',
      }),
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      bus,
    });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: `${'x'.repeat(3000)}\nI could not find the prop.`,
        outcome: 'no-staged-change',
        error: 'exited without changing any files',
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    // One local retry stopped on the no-change outcome; the two consult answers
    // each spent one attempt before the lineage bound halted the ladder.
    expect(implementer.retry).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === 'task_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(2);
    expect(next.pendingRecovery).toMatchObject({ reason: 'consult-bound-spent', taskId: 'T001' });
  });
});

describe('handleFailedImplementation — an effect failure is no scope fence', () => {
  it('retries on the runner error and never sends a revert instruction', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/other.ts': 'committed other\n' });
    const task = makeTask({ id: 'T001', action: 'create', suggestedFiles: ['src/hello.ts'] });
    const state = implementingState([task]);
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/other.ts'), 'agent rewrote this\n');

    const retry = vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: makeImplementer({ retry }),
      bus,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
      }),
    });
    const error = "Tool implementer wrote outside the brief's declared files: src/other.ts";

    await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-effect-invalid',
        error,
      }),
      taskStartSnapshot,
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(retry.mock.calls[0]?.[0]?.error).toBe(error);
    expect(readFileSync(join(projectDir, 'src/other.ts'), 'utf-8')).toBe('agent rewrote this\n');
    expect(JSON.stringify(events)).not.toMatch(/revert/i);
  });

  it('an extracted-code write blocked by a change during approval is an ordinary failed attempt', async () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/app.ts'] });
    const state = implementingState([task]);
    const retry = vi.fn().mockResolvedValue({
      success: false,
      error: 'still blocked',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const { bus } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      implementer: makeImplementer({ retry }),
      bus,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
    });
    const error = extractedCodeApprovalRaceError(task.suggestedFiles[0]);

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({ success: false, output: '', error }),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(retry.mock.calls[0]?.[0]?.error).toBe(error);
    expect(next.pendingRecovery?.reason).not.toBe('approval-promotion-conflict');
  });
});

describe('runTaskLoop — a seat that times out twice on one brief is a seat-down halt', () => {
  const shimDirs: string[] = [];
  let restorePath: (() => void) | undefined;

  afterEach(() => {
    restorePath?.();
    restorePath = undefined;
    vi.unstubAllGlobals();
    while (shimDirs.length > 0) cleanupTempDir(shimDirs.pop() as string);
  });

  async function runUntilHalt(config: Config, implementer: Implementer) {
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode', 'claude-code']));
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      bus,
      config,
    });
    const { state } = await runTaskLoop({
      wctx,
      initialState: implementingState([makeTask({ id: 'T001' })]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    return { state, events };
  }

  // The transcript reads `attempt 2 of 8` above the halt; the halt states the same count.
  function expectTwoAttempts(state: WorkflowState) {
    expect(state.pendingRecovery).toMatchObject({ attempts: 2, maxAttempts: 8 });
    expect(state.pendingRecovery?.details).toContain('Attempts: 2/8');
    expect(formatRecoveryPrompt(state.pendingRecovery!)).toContain(
      'timed out twice in a row on T001 after 2 attempts',
    );
  }

  it('halts a cli seat as runner-timeout-repeated and offers the seat switch', async () => {
    const shimDir = createTempDir('timeout-halt-shim');
    shimDirs.push(shimDir);
    writeFileSync(join(shimDir, 'opencode'), '#!/bin/bash\ncat > /dev/null\nsleep 5\n', {
      mode: 0o755,
    });
    restorePath = prependPath(shimDir);
    const seat: CliImplementerConfig = {
      kind: 'cli',
      tool: 'opencode',
      authChannel: 'provider-dependent',
      contextLength: 8192,
      timeout: 300,
    };
    const config = makeConfig({
      implementer: seat,
      validation: { endChecks: false, testCommand: 'noop' },
    });

    const { state } = await runUntilHalt(
      config,
      createCliImplementer(seat, {
        trustedCli: trustedShimGate({ dir: shimDir, tool: 'opencode' }),
      }),
    );

    expect(state.pendingRecovery).toMatchObject({
      reason: 'runner-timeout-repeated',
      taskId: 'T001',
    });
    expect(state.pendingRecovery?.availableActions).toContain('switch-seat');
    expectTwoAttempts(state);
  });

  it('halts a shell seat as runner-timeout-repeated', async () => {
    const config = makeConfig({
      implementer: {
        kind: 'shell',
        command: '/bin/sleep',
        args: ['10'],
        timeout: 300,
        model: 'test',
        contextLength: 8192,
        outputFormat: 'text',
      },
      validation: { endChecks: false, testCommand: 'noop' },
    });

    const { state } = await runUntilHalt(config, createShellImplementer(config));

    expect(state.pendingRecovery).toMatchObject({
      reason: 'runner-timeout-repeated',
      taskId: 'T001',
    });
    expect(state.pendingRecovery?.availableActions).toContain('switch-seat');
    expectTwoAttempts(state);
  });

  it('halts a shell seat cut twice for silence as runner-timeout-repeated', async () => {
    const config = makeConfig({
      implementer: {
        kind: 'shell',
        command: '/bin/sleep',
        args: ['10'],
        idleWarnMs: 200,
        idleKillMs: 300,
        model: 'test',
        contextLength: 8192,
        outputFormat: 'text',
      },
      validation: { endChecks: false, testCommand: 'noop' },
    });

    const { state, events } = await runUntilHalt(config, createShellImplementer(config));

    expect(state.pendingRecovery).toMatchObject({
      reason: 'runner-timeout-repeated',
      taskId: 'T001',
    });
    expect(state.pendingRecovery?.availableActions).toContain('switch-seat');
    expectTwoAttempts(state);
    expect(events.some((event) => event.type === 'no_progress_cut')).toBe(true);
  });

  it('halts an api seat whose deadline passes twice as runner-timeout-repeated', async () => {
    vi.stubGlobal(
      'fetch',
      withLocalCatalog(
        ['qwen2.5-coder:7b'],
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      ),
    );
    const base = makeConfig({ validation: { endChecks: false, testCommand: 'noop' } });
    const config: Config = { ...base, implementer: { ...base.implementer, timeout: 300 } };

    const { state } = await runUntilHalt(config, createApiImplementer(config));

    expect(state.pendingRecovery).toMatchObject({
      reason: 'runner-timeout-repeated',
      taskId: 'T001',
    });
    expect(state.pendingRecovery?.availableActions).toContain('switch-seat');
    expectTwoAttempts(state);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../events/types.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createValidator } from '../validation/run.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { OrchestratorCallbacks } from '../types.js';
import { HINT_ERROR_TEMPLATE } from '../../../core/pipeline-spec/ladder.js';
import { HINT_TIER, runEscalationTier } from './tier.js';
import type { EscalationContext } from './types.js';

vi.setConfig({ testTimeout: 30_000 });

const RETRY_MARKER = 'src/hello.ts';
const OUT_OF_SCOPE_FILE = 'src/other.ts';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('hint-tier-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-hint-tier';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function writeFileIn(dir: string, relPath: string, contents: string): void {
  const target = join(dir, relPath);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(target, contents);
}

type CtxOptions = {
  callbacks: OrchestratorCallbacks;
  hintWritesOutOfScope?: boolean;
  hintRejects?: boolean;
  hintResult?: { success: boolean; output: string };
  retryResult?: { success: false; outcome: 'no-staged-change'; error: string; output: string };
  signal?: AbortSignal;
};

async function makeCtx(
  projectDir: string,
  sessionId: string,
  opts: CtxOptions,
): Promise<{
  ctx: EscalationContext;
  events: EngineEvent[];
  escalateHint: ReturnType<typeof vi.fn>;
}> {
  const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
  const { bus, events } = makeBusRecorder();
  const escalateHint = vi.fn().mockImplementation(async ({ projectDir: stagedDir }) => {
    if (opts.hintRejects) throw new Error('snapshot failed');
    if (opts.hintWritesOutOfScope) {
      writeFileIn(stagedDir, OUT_OF_SCOPE_FILE, 'export const value = "hint";\n');
    }
    return {
      success: true,
      output: 'try importing foo',
      ...opts.hintResult,
      code: null,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });
  const ctx: EscalationContext = {
    projectDir,
    sessionId,
    config: makeNoValidationConfig({
      workflow: {},
      approval: { enabled: true, feedRejectionsToPlanner: false },
    }),
    callbacks: opts.callbacks,
    bus,
    planner: makePlanner({ escalateHint }),
    reviewer: makePlanner({ escalateHint }),
    context: defaultContext,
    implementer: makeImplementer({
      retry: vi.fn().mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
        if (opts.retryResult) {
          return { ...opts.retryResult, usage: { inputTokens: 20, outputTokens: 10 } };
        }
        writeFileIn(runDir, RETRY_MARKER, 'export const greeting = "retried";\n');
        return { success: true, output: 'fixed', usage: { inputTokens: 20, outputTokens: 10 } };
      }),
    }),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
    isolation: makeCopyingIsolation({ projectDir, sessionId }),
    taskStartSnapshot,
    dependsOnFiles: [],
    ...(opts.signal && { signal: opts.signal }),
  };
  return { ctx, events, escalateHint };
}

describe('runEscalationTier hint tier gate handling', () => {
  it('does not retry after gate denial', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks({
      onTieredApproval: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'user denied' }),
    });
    const { ctx, events } = await makeCtx(projectDir, sessionId, {
      callbacks,
      hintWritesOutOfScope: true,
    });
    const task = makeTask();
    const state = makeImplState([task]);

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(outcome.result).toEqual({
      completed: false,
      method: 'failed',
      attempts: 1,
      lastError: 'Hint-tier changed files blocked by approval gate: user denied (src/other.ts)',
    });
    expect(outcome.lastError).toBe(
      'Hint-tier changed files blocked by approval gate: user denied (src/other.ts)',
    );
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(false);
    expect(events.some((e) => e.type === 'approval_rejected')).toBe(true);
    expect(
      events.some((e) => e.type === 'error' && e.message.includes('blocked by approval gate')),
    ).toBe(true);
  });

  it('does not retry after gate error', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, { callbacks, hintRejects: true });
    const task = makeTask();
    const state = makeImplState([task]);

    await expect(
      runEscalationTier(HINT_TIER, {
        ctx,
        task,
        state,
        lastError: 'validation failed',
        priorAttempts: 0,
      }),
    ).rejects.toThrow('snapshot failed');
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(false);
  });

  it('does not retry after abort', async () => {
    const { projectDir, sessionId } = setupProject();
    const controller = new AbortController();
    controller.abort();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, {
      callbacks,
      signal: controller.signal,
    });
    const task = makeTask();
    const state = makeImplState([task]);

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    // An abort parks the run without spending the attempt: the count stays put.
    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 0 });
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(false);
  });

  it('retries after gate allow', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, { callbacks });
    const task = makeTask();
    const state = makeImplState([task]);

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(outcome.result).toMatchObject({ completed: true, method: 'escalated-hint' });
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(true);
  });

  it('hands the planner the change-detection baseline the acquired workspace declares', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx, escalateHint } = await makeCtx(projectDir, sessionId, { callbacks });
    const task = makeTask();
    const state = makeImplState([task]);

    await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(escalateHint).toHaveBeenCalledWith(
      expect.objectContaining({ changeDetection: 'file-hashes' }),
    );
  });
  it('composes the retry error from the pipeline-spec hint template', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, { callbacks });
    const task = makeTask();
    const state = makeImplState([task]);
    let retryError = '';

    await runEscalationTier(HINT_TIER, {
      ctx: {
        ...ctx,
        implementer: makeImplementer({
          retry: vi.fn().mockImplementation(async ({ error }: { error: string }) => {
            retryError = error;
            return { success: true, output: 'fixed' };
          }),
        }),
      },
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(retryError).toBe(HINT_ERROR_TEMPLATE('validation failed', 'try importing foo'));
  });

  it('publishes the hint after the planner answers and returns it on the outcome', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx, events } = await makeCtx(projectDir, sessionId, {
      callbacks,
      hintResult: { success: true, output: 'use a default' },
    });
    const task = makeTask();

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state: makeImplState([task]),
      lastError: 'validation failed',
      priorAttempts: 1,
    });

    expect(ctx.implementer.retry).toHaveBeenCalledTimes(1);
    const escalates = events.filter((e) => e.type === 'escalate');
    expect(escalates).toHaveLength(1);
    expect(escalates[0]).toMatchObject({ tier: 1, hint: 'use a default' });
    expect(outcome.plannerHint).toBe('use a default');
    expect(outcome.plannerVerdict).toBe('answer');
    expect(outcome.attempts).toBe(2);
  });

  it.each([
    { success: false, output: '' },
    { success: true, output: '   \n  ' },
  ])('ends the rung before the implementer on the hint %j', async (hintResult) => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx, events } = await makeCtx(projectDir, sessionId, { callbacks, hintResult });
    const task = makeTask();

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state: makeImplState([task]),
      lastError: 'validation failed',
      priorAttempts: 1,
    });

    expect(ctx.implementer.retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'escalate')).toEqual([]);
    expect(outcome.result).toBeUndefined();
    expect(outcome.lastError).toBe('validation failed');
    expect(outcome.plannerHint).toBeUndefined();
    expect(outcome.attempts).toBe(1);
  });

  it('hands the implementer hand-back to the planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx, escalateHint } = await makeCtx(projectDir, sessionId, { callbacks });
    const task = makeTask();

    await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state: makeImplState([task]),
      lastError: 'validation failed',
      priorAttempts: 0,
      handBack: 'I could not find the prop.',
    });

    expect(escalateHint).toHaveBeenCalledWith(
      expect.objectContaining({ handBack: 'I could not find the prop.' }),
    );
  });

  it('a brief verdict makes no implementer call and carries the diagnosis out', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const hint = 'VERDICT: brief — the export was already deleted';
    const { ctx, events } = await makeCtx(projectDir, sessionId, {
      callbacks,
      hintResult: { success: true, output: hint },
    });
    const task = makeTask();

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state: makeImplState([task]),
      lastError: 'validation failed',
      priorAttempts: 1,
    });

    expect(ctx.implementer.retry).not.toHaveBeenCalled();
    expect(outcome.result).toBeUndefined();
    expect(outcome).toMatchObject({ plannerHint: hint, plannerVerdict: 'brief', attempts: 1 });
    expect(events.find((e) => e.type === 'escalate')).toMatchObject({ tier: 1, hint });
  });

  it('a widen verdict runs the retry with the write gate open', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, {
      callbacks,
      hintResult: {
        success: true,
        output: 'VERDICT: widen src/other.ts — it consumes the export',
      },
    });
    const task = makeTask();

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state: makeImplState([task]),
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(ctx.implementer.retry).toHaveBeenCalledTimes(1);
    expect(ctx.implementer.retry).toHaveBeenCalledWith(
      expect.objectContaining({ undeclaredWrites: 'gate' }),
    );
    expect(outcome.plannerVerdict).toBe('widen');
  });

  it('aborts only the planner hint call through the registered handler', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, { callbacks });
    const handlers: Array<(() => void) | null> = [];
    let hintSignalAborted = false;
    const escalateHint = vi.fn().mockImplementation(async ({ callbacks: hintCallbacks }) => {
      handlers.at(-1)?.();
      hintSignalAborted = hintCallbacks.signal.aborted;
      return { success: true, output: 'try importing foo', code: null, usage: null };
    });
    const task = makeTask();
    const state = makeImplState([task]);

    await runEscalationTier(HINT_TIER, {
      ctx: {
        ...ctx,
        planner: makePlanner({ escalateHint }),
        sinks: {
          ...TEST_SINKS,
          setAbortHandler: (handler) => {
            handlers.push(handler);
          },
        },
      },
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(hintSignalAborted).toBe(true);
    expect(handlers.at(-1)).toBeNull();
    expect(ctx.signal).toBeUndefined();
  });

  it('a hinted retry that changed nothing returns the incoming error', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { ctx } = await makeCtx(projectDir, sessionId, {
      callbacks,
      retryResult: {
        success: false,
        outcome: 'no-staged-change',
        error: 'Tool implementer (fixture) exited without changing any files',
        output: 'I could not find the registry.',
      },
    });
    const task = makeTask();
    const state = makeImplState([task]);

    const outcome = await runEscalationTier(HINT_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    expect(outcome.lastError).toBe('validation failed');
    expect(outcome.lastFailure?.handBack).toBe('I could not find the registry.');
    expect(outcome.plannerHint).toBe('try importing foo');
  });
});

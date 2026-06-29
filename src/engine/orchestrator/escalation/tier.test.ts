import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../events/types.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { createValidator } from '../validation.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { OrchestratorCallbacks } from '../types.js';
import {
  HINT_TIER,
  INTERMEDIATE_TIER,
  resolveIntermediateConfig,
  runEscalationTier,
} from './tier.js';
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
  signal?: AbortSignal;
};

async function makeCtx(
  projectDir: string,
  sessionId: string,
  opts: CtxOptions,
): Promise<{ ctx: EscalationContext; events: EngineEvent[] }> {
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
      code: null,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  });
  const ctx: EscalationContext = {
    projectDir,
    sessionId,
    config: makeNoValidationConfig({
      workflow: { commitStrategy: 'none' },
      approval: { enabled: true, feedRejectionsToPlanner: false },
    }),
    callbacks: opts.callbacks,
    bus,
    planner: makePlanner({ escalateHint }),
    context: defaultContext,
    implementer: makeImplementer({
      retry: vi.fn().mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
        writeFileIn(runDir, RETRY_MARKER, 'export const greeting = "retried";\n');
        return { success: true, output: 'fixed', usage: { inputTokens: 20, outputTokens: 10 } };
      }),
    }),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
    taskStartSnapshot,
    dependsOnFiles: [],
    ...(opts.signal && { signal: opts.signal }),
  };
  return { ctx, events };
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

    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
    expect(outcome.lastError).toBe('user denied');
    // The hint-assisted retry never ran: its marker file is absent from the project.
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
    // The retry pipeline never executed, so no marker file was promoted.
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

    expect(outcome.result).toEqual({ completed: false, method: 'failed', attempts: 1 });
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
    // The hint-assisted retry ran and its output was promoted into the project.
    expect(existsSync(join(projectDir, RETRY_MARKER))).toBe(true);
  });
});

describe('runEscalationTier intermediate tier guard ordering', () => {
  it('does not publish a tier-0 escalate event when intermediate credentials are missing', async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const { projectDir, sessionId } = setupProject();
      const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
      const { bus, events } = makeBusRecorder();
      const { callbacks } = makeCallbacks();
      const ctx: EscalationContext = {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          implementer: {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen',
            apiBase: 'http://localhost:11434/v1',
          },
          escalation: {
            intermediateProvider: 'openrouter',
            intermediateModel: 'openrouter/model',
            enabled: true,
          },
        }),
        callbacks,
        bus,
        planner: makePlanner({}),
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
        taskStartSnapshot,
        dependsOnFiles: [],
      };
      const task = makeTask();
      const state = makeImplState([task]);

      const outcome = await runEscalationTier(INTERMEDIATE_TIER, {
        ctx,
        task,
        state,
        lastError: 'validation failed',
        priorAttempts: 0,
      });

      expect(outcome.attempts).toBe(0);
      expect(events.some((e) => e.type === 'escalate')).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'warning',
          message: expect.stringContaining('OpenRouter intermediate provider is missing'),
        }),
      );
    } finally {
      if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it('does not publish a tier-0 escalate event when the intermediate config cannot resolve', async () => {
    const { projectDir, sessionId } = setupProject();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const { bus, events } = makeBusRecorder();
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config: makeNoValidationConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
        escalation: {
          intermediateProvider: 'made-up-provider',
          intermediateModel: 'made-up-model',
          enabled: true,
        },
      }),
      callbacks,
      bus,
      planner: makePlanner({}),
      context: defaultContext,
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot,
      dependsOnFiles: [],
    };
    const task = makeTask();
    const state = makeImplState([task]);

    const outcome = await runEscalationTier(INTERMEDIATE_TIER, {
      ctx,
      task,
      state,
      lastError: 'validation failed',
      priorAttempts: 0,
    });

    // The tier returns without consuming an attempt because the config never resolved.
    expect(outcome.attempts).toBe(0);
    // No phantom escalate event leaked before the resolution guard ran.
    expect(events.some((e) => e.type === 'escalate')).toBe(false);
    // The user is still warned about the unresolvable provider.
    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });
});

describe('resolveIntermediateConfig', () => {
  function makeIntermediateCtx(): EscalationContext {
    const { projectDir, sessionId } = setupProject();
    const { bus } = makeBusRecorder();
    const { callbacks } = makeCallbacks();
    return {
      projectDir,
      sessionId,
      config: makeNoValidationConfig({
        implementer: {
          kind: 'api',
          provider: 'ollama',
          model: 'qwen2.5-coder:7b',
          apiBase: 'http://localhost:11434/v1',
          contextLength: 32768,
          temperature: 0.2,
          customModels: ['qwen2.5-coder:7b'],
        },
        escalation: {
          intermediateProvider: 'deepseek',
          intermediateModel: 'deepseek-chat',
          enabled: true,
        },
      }),
      callbacks,
      bus,
      planner: makePlanner({}),
      context: defaultContext,
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot: { head: '', files: [], dirtyFileContents: {} },
      dependsOnFiles: [],
    };
  }

  it('resolves the intermediate window from the catalog for that model, not the primary', () => {
    const ctx = makeIntermediateCtx();
    const state = makeImplState([makeTask()]);

    const resolved = resolveIntermediateConfig(ctx, state);

    expect(resolved?.implementer).toMatchObject({
      kind: 'api',
      provider: 'deepseek',
      model: 'deepseek-chat',
      // deepseek-chat's catalog window, never the primary's 32768.
      contextLength: 128_000,
    });
  });

  it('does not inherit the primary temperature or customModels', () => {
    const ctx = makeIntermediateCtx();
    const state = makeImplState([makeTask()]);

    const resolved = resolveIntermediateConfig(ctx, state);
    const intermediate = resolved?.implementer;

    expect(intermediate?.kind).toBe('api');
    if (intermediate?.kind !== 'api') throw new Error('expected api implementer');
    expect(intermediate.temperature).toBeUndefined();
    expect(intermediate.customModels).toBeUndefined();
  });
});

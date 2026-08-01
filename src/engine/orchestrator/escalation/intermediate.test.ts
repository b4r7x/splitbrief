import { afterEach, describe, expect, it } from 'vitest';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createValidator } from '../validation/run.js';
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
import { INTERMEDIATE_TIER, runEscalationTier } from './tier.js';
import { resolveIntermediateConfig } from './intermediate.js';
import type { EscalationContext } from './types.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('intermediate-tier-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-intermediate-tier';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

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

    expect(outcome.attempts).toBe(0);
    expect(events.some((e) => e.type === 'escalate')).toBe(false);
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
          intermediateModel: 'deepseek-v4-flash',
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
      service: 'deepseek',
      offering: 'payg',
      model: 'deepseek-v4-flash',
      contextLength: 1_000_000,
    });
  });

  it('retains the current endpoint identity when an unknown provider uses its fallback', () => {
    const ctx = makeIntermediateCtx();
    ctx.config.escalation = {
      intermediateProvider: 'custom-proxy',
      intermediateModel: 'custom-model',
      enabled: true,
    };
    const state = makeImplState([makeTask()]);

    const resolved = resolveIntermediateConfig(ctx, state);

    expect(resolved?.implementer).toMatchObject({
      kind: 'api',
      provider: 'custom-proxy',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'custom-model',
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

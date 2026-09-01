import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createValidator } from '../validation/run.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { ConfigSchema } from '../../../core/schemas/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePreparedImplementerFactory,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { RunnerGate } from '../../runners/prepared-execution.js';
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
          intermediateProvider: 'custom-endpoint',
          intermediateModel: 'custom-endpoint/model',
          enabled: true,
        },
      }),
      callbacks,
      bus,
      planner: makePlanner({}),
      reviewer: makePlanner({}),
      context: defaultContext,
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      isolation: makeCopyingIsolation({ projectDir: projectDir, sessionId }),
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
        message: expect.stringContaining(
          'Custom provider custom-endpoint intermediate provider is missing',
        ),
      }),
    );
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
      reviewer: makePlanner({}),
      context: defaultContext,
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      isolation: makeCopyingIsolation({ projectDir: projectDir, sessionId }),
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

  it('uses the prepared intermediate gate without a second admission path', async () => {
    const { projectDir, sessionId } = setupProject();
    const sentinel = join(projectDir, 'configured-default-ran');
    const childProgram = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');`;
    const config = ConfigSchema.parse({
      ...makeNoValidationConfig({
        escalation: {
          intermediateProvider: 'ollama',
          intermediateModel: 'x-ai/grok-4-fast',
          enabled: true,
        },
      }),
      customCommands: {
        'intermediate-sentinel': {
          label: 'Intermediate sentinel',
          contract: 'output',
          executable: process.execPath,
          argv: ['-e', childProgram],
          outputFormat: 'text',
        },
      },
      implementerProfiles: {
        default: 'intermediate-sentinel',
        profiles: {
          'intermediate-sentinel': {
            kind: 'shell',
            command: process.execPath,
            args: ['-e', childProgram],
            outputFormat: 'text',
            model: 'configured-default',
          },
        },
      },
    });
    const originalConfig = structuredClone(config);
    const originalProfiles = config.implementerProfiles;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeOpenAiSseResponse([
          { content: '```ts\nexport const intermediate = true;\n```' },
          { usage: { prompt_tokens: 40, completion_tokens: 20 } },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const preparationId = 'intermediate-preparation';
    const gates: RunnerGate[] = [
      {
        kind: 'api',
        slot: { role: 'intermediate' },
        preparationId,
        provider: 'ollama',
        endpointOrigin: 'http://localhost:11434',
      },
    ];
    const preparedFactory = vi.fn(
      makePreparedImplementerFactory({
        preparationId,
        gates,
        slot: { role: 'intermediate' },
      }),
    );

    try {
      const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
      const { bus, events } = makeBusRecorder();
      const { callbacks } = makeCallbacks();
      const task = makeTask({ id: 'T001', file: 'src/intermediate.ts', action: 'create' });
      const outcome = await runEscalationTier(INTERMEDIATE_TIER, {
        ctx: {
          projectDir,
          sessionId,
          config,
          callbacks,
          bus,
          planner: makePlanner({}),
          reviewer: makePlanner({}),
          context: defaultContext,
          implementer: makeImplementer(),
          createImplementer: preparedFactory,
          metadata: TEST_METADATA,
          sinks: TEST_SINKS,
          validator: createValidator(),
          isolation: makeCopyingIsolation({ projectDir: projectDir, sessionId }),
          taskStartSnapshot,
          dependsOnFiles: [],
        },
        task,
        state: makeImplState([task]),
        lastError: 'validation failed',
        priorAttempts: 0,
      });

      expect(outcome.result).toMatchObject({
        completed: true,
        method: 'escalated-intermediate',
        tool: 'ollama',
        model: 'x-ai/grok-4-fast',
      });
      expect(events).toContainEqual(expect.objectContaining({ type: 'escalate', tier: 0 }));
      expect(fetchMock).toHaveBeenCalled();
      expect(preparedFactory).toHaveBeenCalledOnce();
      expect(preparedFactory.mock.calls[0]?.[1]).toMatchObject({
        slot: { role: 'intermediate' },
      });
      expect(existsSync(sentinel)).toBe(false);
      expect(config).toEqual(originalConfig);
      expect(config.implementerProfiles).toBe(originalProfiles);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('resolveIntermediateConfig', () => {
  const modelCache: ModelCacheAccessor = {
    getModelsDevCatalog: () => null,
    getProviderModels: (providerId) =>
      providerId === 'lm-studio' ? [{ id: 'deepseek-v4-flash', contextLength: 1_000_000 }] : null,
  };

  function makeIntermediateCtx(): EscalationContext {
    const { projectDir, sessionId } = setupProject();
    const { bus } = makeBusRecorder();
    const { callbacks } = makeCallbacks();
    return {
      modelCache,
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
          intermediateProvider: 'lm-studio',
          intermediateModel: 'deepseek-v4-flash',
          enabled: true,
        },
      }),
      callbacks,
      bus,
      planner: makePlanner({}),
      reviewer: makePlanner({}),
      context: defaultContext,
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      isolation: makeCopyingIsolation({ projectDir: projectDir, sessionId }),
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
      provider: 'lm-studio',
      service: 'lm-studio',
      offering: 'local',
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

import { afterEach, describe, expect, it } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeCallbacks,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createValidator } from '../validation/run.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { stateForRetryProfile, createRetryRuntime } from './retry-runtime.js';
import type { EscalationContext } from './types.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('retry-runtime-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-retry-runtime';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function configWithProfiles() {
  return {
    ...makeNoValidationConfig({
      approval: { enabled: false, feedRejectionsToPlanner: true },
      workflow: { commitStrategy: 'none' },
    }),
    implementerProfiles: {
      default: 'cheap-large',
      profiles: {
        'cheap-large': {
          kind: 'api' as const,
          provider: 'deepseek',
          service: 'deepseek',
          offering: 'payg' as const,
          apiBase: 'https://api.deepseek.com/v1',
          apiKey: 'test-key',
          model: 'deepseek-chat',
          costTier: 'cheap' as const,
          contextLength: 128_000,
        },
      },
    },
  };
}

describe('stateForRetryProfile', () => {
  it('updates implementer tool and model from profile', () => {
    const state = makeImplState([], { implementerTool: 'ollama', implementerModel: 'qwen' });
    const profile = {
      name: 'test',
      config: {
        kind: 'api' as const,
        provider: 'openai',
        service: 'openai',
        offering: 'payg' as const,
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'key',
        model: 'gpt-4',
        costTier: 'frontier' as const,
        contextLength: 8192,
      },
      costTier: 'frontier' as const,
      capabilities: { writesFiles: 'direct' as const },
      isDefault: false,
    };
    const result = stateForRetryProfile(state, profile);
    expect(result.implementerTool).toBe('openai');
    expect(result.implementerModel).toBe('gpt-4');
  });

  it('preserves existing implementerModel when profile model is unchanged', () => {
    const state = makeImplState([], { implementerTool: 'ollama', implementerModel: 'qwen' });
    const profile = {
      name: 'test',
      config: {
        kind: 'api' as const,
        provider: 'openai',
        service: 'openai',
        offering: 'payg' as const,
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'key',
        model: 'qwen',
        costTier: 'frontier' as const,
        contextLength: 8192,
      },
      costTier: 'frontier' as const,
      capabilities: { writesFiles: 'direct' as const },
      isDefault: false,
    };
    const result = stateForRetryProfile(state, profile);
    expect(result.implementerTool).toBe('openai');
    expect(result.implementerModel).toBe('qwen');
  });
});

describe('createRetryRuntime', () => {
  it('returns existing implementer when no override', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = configWithProfiles();
    const { bus } = makeBusRecorder();
    const implementer = makeImplementer();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir },
      implementer,
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot,
      dependsOnFiles: [],
    };

    const runtime = await createRetryRuntime(ctx, undefined);

    expect(runtime.config).toBe(config);
    expect(runtime.implementer).toBe(implementer);
    expect(runtime.implementerProfile).toBeUndefined();
  });

  it('throws for nonexistent profile', async () => {
    const { projectDir, sessionId } = setupProject();
    const config = configWithProfiles();
    const { bus } = makeBusRecorder();
    const implementer = makeImplementer();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const { callbacks } = makeCallbacks();
    const ctx: EscalationContext = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus,
      planner: makePlanner(),
      context: { name: 'test', dir: projectDir },
      implementer,
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
      taskStartSnapshot,
      dependsOnFiles: [],
    };

    await expect(createRetryRuntime(ctx, 'nonexistent')).rejects.toThrow(/nonexistent/);
  });
});

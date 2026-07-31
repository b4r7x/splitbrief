import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import { modelCacheStore } from './model-cache.js';
import { detectionStore } from '../project/detection.js';
import { loadDetectionIntoStores, refreshDetectionStores } from './detection-adapter.js';
import type { DetectionDeps, DetectionServiceResult } from '../../engine/detection/service.js';
import { createDetectionService } from '../../engine/detection/service.js';

const makeCliTool = (overrides?: Partial<CliToolDetection>): CliToolDetection => ({
  tool: 'claude-code',
  executable: null,
  trust: 'trusted',
  installedVersion: '1.0.0',
  testedVersion: '1.0.0',
  compatibility: 'compatible',
  auth: 'authenticated',
  diagnostic: { state: 'ready', remediation: null },
  probedAt: 1_700_000_000_000,
  ...overrides,
});

const makeImplementer = (overrides?: Partial<ProviderDetection>): ProviderDetection => ({
  provider: 'ollama',
  available: true,
  isLocal: true,
  ...overrides,
});

describe('loadDetectionIntoStores', () => {
  beforeEach(() => {
    detectionStore.reset();
    modelCacheStore.reset();
  });

  it('projects canonical CLI and provider detections into the existing store boundary', async () => {
    const cliTools = [
      makeCliTool({ tool: 'claude-code' }),
      makeCliTool({
        tool: 'codex',
        installedVersion: '9.0.0',
        testedVersion: '0.40.0',
        compatibility: 'incompatible',
        diagnostic: { state: 'incompatible', remediation: 'Install a compatible Codex version' },
      }),
    ];
    const providers = [
      makeImplementer({ provider: 'ollama' }),
      makeImplementer({ provider: 'lm-studio', available: false }),
    ];
    const deps: DetectionDeps = {
      detectAll: async () => ({ providers, cliTools }),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };
    const fixedResult: DetectionServiceResult = {
      providers,
      cliTools,
      catalog: null,
      cliModels: {},
    };
    const loadDetection = vi.fn().mockResolvedValue(fixedResult);
    const service = {
      loadDetection,
      refreshDetection: vi.fn(),
      invalidateDetection: vi.fn(),
    };

    await loadDetectionIntoStores(service, deps, detectionStore, undefined);

    const state = detectionStore.get();
    expect(state.planners).toEqual([
      {
        tool: 'claude-code',
        type: 'cli',
        available: true,
        version: '1.0.0',
        description: 'Claude Code CLI',
      },
      {
        tool: 'codex',
        type: 'cli',
        available: false,
        version: '9.0.0',
        description: 'OpenAI Codex CLI',
        error: 'Install a compatible Codex version',
      },
    ]);
    expect(state.implementers).toEqual(providers);
  });

  it('forwards projectDir and applies the service result to stores', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'splitbrief-detection-adapter-forward-'));
    const catalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            cost: { input: 3, output: 15 },
            limit: { context: 1_000_000 },
          },
        },
      },
    };
    const cliTools = [makeCliTool({ tool: 'claude-code', installedVersion: 'service-fixed' })];
    const providers = [
      makeImplementer({
        provider: 'ollama',
        models: [
          {
            id: 'nested-model',
            capabilities: ['tools'],
            pricingTiers: [{ type: 'context', thresholdTokens: 0, inputPer1M: 1, outputPer1M: 2 }],
          },
        ],
      }),
    ];
    const fixedResult: DetectionServiceResult = {
      providers,
      cliTools,
      catalog,
      cliModels: { opencode: [{ id: 'anthropic/claude-sonnet-4.6' }] },
    };
    const deps: DetectionDeps = {
      detectAll: vi.fn(),
      fetchModelsDevCatalog: vi.fn(),
      discoverAllCliTools: vi.fn(),
    };
    const loadDetection = vi.fn().mockResolvedValue(fixedResult);
    const service = {
      loadDetection,
      refreshDetection: vi.fn(),
      invalidateDetection: vi.fn(),
    };

    await loadDetectionIntoStores(service, deps, detectionStore, projectDir);

    expect(loadDetection).toHaveBeenCalledWith(deps, projectDir);
    expect(detectionStore.get().planners[0]?.version).toBe('service-fixed');
    expect(detectionStore.get().implementers).toEqual(providers);
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
    expect(modelCacheStore.getProviderModels('opencode')).toEqual([
      { id: 'anthropic/claude-sonnet-4.6' },
    ]);

    providers[0]?.models?.[0]?.capabilities?.push('mutated');
    const firstTier = providers[0]?.models?.[0]?.pricingTiers?.[0];
    if (!firstTier) throw new Error('Expected provider pricing tier');
    firstTier.inputPer1M = 99;
    expect(detectionStore.get().implementers[0]?.models?.[0]).toEqual({
      id: 'nested-model',
      capabilities: ['tools'],
      pricingTiers: [{ type: 'context', thresholdTokens: 0, inputPer1M: 1, outputPer1M: 2 }],
    });

    await rm(projectDir, { recursive: true, force: true });
  });
});

describe('refreshDetectionStores', () => {
  let service: ReturnType<typeof createDetectionService>;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'splitbrief-refresh-detection-test-'));
    service = createDetectionService();
    detectionStore.reset();
    modelCacheStore.reset();
  });

  afterEach(async () => {
    await service.getPendingSave();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('updates detectionStore and modelCacheStore from fresh detection (regression: /refresh must apply results)', async () => {
    const catalog = {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            cost: { input: 3, output: 15 },
            limit: { context: 1_000_000 },
          },
        },
      },
    };
    const cliModels = { opencode: [{ id: 'anthropic/claude-sonnet-4.6' }] };

    let detectCalls = 0;
    const deps: DetectionDeps = {
      detectAll: async () => {
        detectCalls++;
        return {
          providers: [makeImplementer({ provider: 'ollama' })],
          cliTools: [
            makeCliTool({
              tool: 'claude-code',
              installedVersion: `refresh-gen-${detectCalls}`,
            }),
          ],
        };
      },
      fetchModelsDevCatalog: vi.fn().mockResolvedValue(catalog),
      discoverAllCliTools: vi.fn().mockResolvedValue(cliModels),
    };

    await service.loadDetection(deps, tempDir);
    await service.getPendingSave();

    detectionStore.reset();
    modelCacheStore.reset();
    expect(detectionStore.get().planners).toEqual([]);

    await refreshDetectionStores(service, detectionStore, tempDir);

    const state = detectionStore.get();
    expect(state.planners.length).toBe(1);
    expect(state.planners[0]?.version).toBe('refresh-gen-2');
    expect(state.implementers.length).toBe(1);
    expect(state.implementers[0]?.provider).toBe('ollama');
    expect(modelCacheStore.getModelsDevCatalog()).toEqual(catalog);
    expect(modelCacheStore.getProviderModels('opencode')).toEqual(cliModels.opencode);
  });

  it('invalidates model cache before applying fresh results', async () => {
    const deps: DetectionDeps = {
      detectAll: async () => ({
        providers: [makeImplementer()],
        cliTools: [makeCliTool()],
      }),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };

    await service.loadDetection(deps, tempDir);
    modelCacheStore.setProviderModels('ollama', [{ id: 'stale-model' }]);

    await refreshDetectionStores(service, detectionStore, tempDir);

    expect(modelCacheStore.getProviderModels('ollama')).toBeNull();
  });
});

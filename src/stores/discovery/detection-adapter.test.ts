import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { CliReadinessFacts } from '../../core/schemas/readiness.js';
import { modelCacheStore } from './model-cache.js';
import { detectionStore } from '../project/detection.js';
import { loadDetectionIntoStores, refreshDetectionStores } from './detection-adapter.js';
import type { DetectionDeps, DetectionServiceResult } from '../../engine/detection/service.js';
import { createDetectionService } from '../../engine/detection/service.js';

const makeCliTool = (
  overrides: { tool?: CliToolDetection['tool'] } & Partial<CliReadinessFacts> = {},
): CliToolDetection => {
  const { tool = 'claude-code', ...facts } = overrides;
  return cliDetectionFor('ready', tool, facts);
};

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

  it('applies canonical CLI and provider detections to the store boundary', async () => {
    const cliTools = [
      makeCliTool({ tool: 'claude-code' }),
      cliDetectionFor('incompatible', 'codex'),
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
    expect(state.cliTools).toEqual(cliTools);
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
    expect(detectionStore.get().cliTools[0]?.installedVersion).toBe('service-fixed');
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

  it('keeps every detected CLI tool role-neutral in the store', async () => {
    const deps: DetectionDeps = {
      detectAll: async () => ({
        providers: [makeImplementer()],
        cliTools: [makeCliTool({ tool: 'opencode', installedVersion: '0.5.0' }), makeCliTool()],
      }),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };

    await loadDetectionIntoStores(createDetectionService(), deps, detectionStore, undefined);

    expect(detectionStore.get().cliTools.map((cliTool) => cliTool.tool)).toEqual([
      'opencode',
      'claude-code',
    ]);
  });

  it('isolates CLI readiness diagnostics from later source mutation', async () => {
    const cliTools = [cliDetectionFor('incompatible', 'codex')];
    const produced = cliTools[0]?.diagnostic;
    const deps: DetectionDeps = {
      detectAll: async () => ({ providers: [], cliTools }),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };

    await loadDetectionIntoStores(createDetectionService(), deps, detectionStore, undefined);

    cliTools[0]!.diagnostic = { state: 'ready', remediation: null };
    expect(detectionStore.get().cliTools[0]?.diagnostic).toEqual(produced);
  });

  it('round-trips provider and CLI detections through the service cache without alias loss', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'splitbrief-detection-adapter-roundtrip-'));
    const service = createDetectionService();
    const executablePath = join(tmpdir(), 'codex-roundtrip');
    const cliTools: CliToolDetection[] = [
      cliDetectionFor('incompatible', 'codex', {
        executable: { path: executablePath, fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 } },
      }),
    ];
    const producedDiagnostic = cliTools[0]?.diagnostic;
    const providers: ProviderDetection[] = [
      {
        provider: 'openrouter',
        available: true,
        isLocal: false,
        models: [
          {
            id: 'anthropic/claude-3.5-sonnet',
            pricingTiers: [
              { type: 'context', thresholdTokens: 0, inputPer1M: 3, outputPer1M: 15 },
              { type: 'context', thresholdTokens: 200_000, inputPer1M: 6, outputPer1M: 22.5 },
            ],
          },
        ],
      },
    ];
    const deps: DetectionDeps = {
      detectAll: async () => ({ providers, cliTools }),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
      discoverAllCliTools: vi.fn().mockResolvedValue({}),
    };

    await service.loadDetection(deps, projectDir);
    await service.getPendingSave();

    const second = await service.loadDetection(deps, projectDir);
    expect(second.providers).toEqual(providers);
    expect(second.cliTools).toEqual(cliTools);

    const loadedTier = second.providers[0]?.models?.[0]?.pricingTiers?.[0];
    if (!loadedTier) throw new Error('Expected cached pricing tier');
    loadedTier.inputPer1M = 99;
    second.cliTools[0]!.diagnostic = { state: 'ready', remediation: null };
    second.cliTools[0]!.executable!.fingerprint.mtimeMs = 99;

    const third = await service.loadDetection(deps, projectDir);
    expect(third.providers[0]?.models?.[0]?.pricingTiers?.[0]?.inputPer1M).toBe(3);
    expect(third.cliTools[0]?.diagnostic).toEqual(producedDiagnostic);
    expect(third.cliTools[0]?.executable?.fingerprint.mtimeMs).toBe(4);

    providers[0]!.models![0]!.pricingTiers![0]!.inputPer1M = 99;
    cliTools[0]!.diagnostic = { state: 'ready', remediation: null };
    expect(third.providers[0]?.models?.[0]?.pricingTiers?.[0]?.inputPer1M).toBe(3);

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
    expect(detectionStore.get().cliTools).toEqual([]);

    await refreshDetectionStores(service, detectionStore, tempDir);

    const state = detectionStore.get();
    expect(state.cliTools.length).toBe(1);
    expect(state.cliTools[0]?.installedVersion).toBe('refresh-gen-2');
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

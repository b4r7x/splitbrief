import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannerDetection, ProviderDetection } from '../../core/discovery/detection.js';
import { createDetectionService } from './service.js';
import type { DetectionDeps } from './service.js';

const makePlanner = (overrides?: Partial<PlannerDetection>): PlannerDetection => ({
  tool: 'claude-code',
  type: 'cli',
  available: true,
  ...overrides,
});

const makeImplementer = (overrides?: Partial<ProviderDetection>): ProviderDetection => ({
  provider: 'ollama',
  available: true,
  isLocal: true,
  ...overrides,
});

function makeCountingDeps(overrides: Partial<DetectionDeps> = {}): DetectionDeps {
  let calls = 0;
  const detectAll = async () => {
    calls++;
    return {
      planners: [makePlanner({ version: `gen-${calls}` })],
      implementers: [makeImplementer()],
    };
  };
  return {
    detectAll,
    fetchModelsDevCatalog: vi.fn().mockResolvedValue({}),
    discoverAllCliTools: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('createDetectionService loadDetection', () => {
  let service: ReturnType<typeof createDetectionService>;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'splitbrief-detection-service-test-'));
    service = createDetectionService();
  });

  afterEach(async () => {
    await service.getPendingSave();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('uses cache on second call when projectDir is supplied', async () => {
    const deps = makeCountingDeps();

    const first = await service.loadDetection(deps, tempDir);
    expect(first.detection.planners[0]?.version).toBe('gen-1');

    await service.getPendingSave();
    const second = await service.loadDetection(deps, tempDir);
    expect(second.detection.planners[0]?.version).toBe('gen-1');
  });

  it('hydrates models.dev and CLI discovery on cache hit', async () => {
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
    const deps: DetectionDeps = {
      ...makeCountingDeps(),
      fetchModelsDevCatalog: vi.fn().mockResolvedValue(catalog),
      discoverAllCliTools: vi
        .fn()
        .mockResolvedValue({ opencode: [{ id: 'anthropic/claude-sonnet-4.6' }] }),
    };

    const first = await service.loadDetection(deps, tempDir);
    expect(first.detection.planners[0]?.version).toBe('gen-1');
    expect(first.catalog).toEqual(catalog);
    expect(first.cliModels.opencode).toEqual([{ id: 'anthropic/claude-sonnet-4.6' }]);

    await service.getPendingSave();
    const second = await service.loadDetection(deps, tempDir);
    expect(second.detection.planners[0]?.version).toBe('gen-1');
    expect(second.catalog).toEqual(catalog);
    expect(second.cliModels.opencode).toEqual([{ id: 'anthropic/claude-sonnet-4.6' }]);
  });

  it('always runs detection when projectDir is undefined (no cache scope)', async () => {
    const deps = makeCountingDeps();

    const first = await service.loadDetection(deps, undefined);
    expect(first.detection.planners[0]?.version).toBe('gen-1');

    const second = await service.loadDetection(deps, undefined);
    expect(second.detection.planners[0]?.version).toBe('gen-2');
  });

  it('invalidate() forces re-detection on next load', async () => {
    const deps = makeCountingDeps();

    const first = await service.loadDetection(deps, tempDir);
    expect(first.detection.planners[0]?.version).toBe('gen-1');

    await service.getPendingSave();
    await service.invalidateDetection(tempDir);

    const second = await service.loadDetection(deps, tempDir);
    expect(second.detection.planners[0]?.version).toBe('gen-2');
  });
});

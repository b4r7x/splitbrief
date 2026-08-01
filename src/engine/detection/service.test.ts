import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { CliReadinessFacts } from '../../core/schemas/readiness.js';
import { createDetectionService } from './service.js';
import type { DetectionDeps } from './service.js';

const makeCliTool = (
  overrides: { tool?: CliToolDetection['tool'] } & Partial<CliReadinessFacts> = {},
): CliToolDetection => {
  const { tool = 'claude-code', ...facts } = overrides;
  return cliDetectionFor('ready', tool, facts);
};

const makeProvider = (overrides?: Partial<ProviderDetection>): ProviderDetection => ({
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
      providers: [makeProvider()],
      cliTools: [makeCliTool({ installedVersion: `gen-${calls}` })],
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
    expect(first.cliTools[0]?.installedVersion).toBe('gen-1');

    await service.getPendingSave();
    const second = await service.loadDetection(deps, tempDir);
    expect(second.cliTools[0]?.installedVersion).toBe('gen-1');
    expect(second.providers[0]?.provider).toBe('ollama');
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
    expect(first.cliTools[0]?.installedVersion).toBe('gen-1');
    expect(first.catalog).toEqual(catalog);
    expect(first.cliModels.opencode).toEqual([{ id: 'anthropic/claude-sonnet-4.6' }]);

    await service.getPendingSave();
    const second = await service.loadDetection(deps, tempDir);
    expect(second.cliTools[0]?.installedVersion).toBe('gen-1');
    expect(second.catalog).toEqual(catalog);
    expect(second.cliModels.opencode).toEqual([{ id: 'anthropic/claude-sonnet-4.6' }]);
  });

  it('always runs detection when projectDir is undefined (no cache scope)', async () => {
    const deps = makeCountingDeps();

    const first = await service.loadDetection(deps, undefined);
    expect(first.cliTools[0]?.installedVersion).toBe('gen-1');

    const second = await service.loadDetection(deps, undefined);
    expect(second.cliTools[0]?.installedVersion).toBe('gen-2');
  });

  it('invalidate() forces re-detection on next load', async () => {
    const deps = makeCountingDeps();

    const first = await service.loadDetection(deps, tempDir);
    expect(first.cliTools[0]?.installedVersion).toBe('gen-1');

    await service.getPendingSave();
    await service.invalidateDetection(tempDir);

    const second = await service.loadDetection(deps, tempDir);
    expect(second.cliTools[0]?.installedVersion).toBe('gen-2');
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { writeConfig } from '../../core/config/load/io.js';
import { saveDetectionCache } from '../../engine/detection/cache.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import {
  MODELS_DEV_CATALOG_PARSER_VERSION,
  MODELS_DEV_CATALOG_URL,
  resolveModelsDevCatalogCachePath,
} from '../../engine/providers/models-dev-cache/store.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { loadRememberedCatalog } from './discovery.js';

vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: vi.fn(),
}));

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('remembered-catalog');
  resetAllStores();
  vi.mocked(os.homedir).mockReturnValue(projectDir);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network probe'));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAllStores();
  cleanupTempDir(projectDir);
});

it('loads remembered model labels without running discovery', async () => {
  const runner = { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' } as const;
  writeConfig(projectDir, makeConfig({ implementer: runner }));
  await saveDetectionCache({
    projectDir,
    snapshot: {
      contextKey: 'another-config',
      fetchedAt: 1,
      validatedAt: 1,
      generation: 8,
      requestId: 9,
      providers: [],
      cliTools: [],
      cliCatalogs: [
        { tool: 'codex', models: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }], probedAt: 1 },
      ],
    },
  });

  await loadRememberedCatalog(projectDir);

  expect(resolveSeatDisplayName(runner, 'implementer', modelCacheStore)).toBe('GPT-6-Luna');
  expect(modelCacheStore.get().refresh.readiness.outcome).toBe('stale');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('loads the remembered models.dev catalog when there is no tool snapshot', async () => {
  const path = resolveModelsDevCatalogCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      sourceUrl: MODELS_DEV_CATALOG_URL,
      parserVersion: MODELS_DEV_CATALOG_PARSER_VERSION,
      fetchedAt: 1,
      validatedAt: 1,
      catalog: {
        openai: {
          id: 'openai',
          models: { 'gpt-6-luna': { id: 'gpt-6-luna', name: 'GPT-6-Luna' } },
        },
      },
    }),
  );

  await loadRememberedCatalog(projectDir);

  expect(modelCacheStore.getModelsDevCatalog()?.openai?.models['gpt-6-luna']?.name).toBe(
    'GPT-6-Luna',
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('reports a configuration failure when catalog loading cannot continue', async () => {
  mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
  writeFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'version: invalid');
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await expect(loadRememberedCatalog(projectDir)).resolves.toBeUndefined();
  expect(stderr.mock.calls.flat().join('')).toContain('Could not load model names');
  expect(stderr.mock.calls.flat().join('')).toContain('Unsupported config version');
  expect(modelCacheStore.getProviderModels('codex')).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

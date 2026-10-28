import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { loadRememberedSnapshot } from '../../../src/engine/detection/cache.js';
import { createDetectionService } from '../../../src/engine/detection/service.js';
import { refreshDetectionForCurrentConfig } from '../../../src/engine/detection/store-publication.js';
import { refreshPickerDetection } from '../../../src/features/runners/refresh-detection.js';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache/state.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { shellQuoteArg } from '../../../src/utils/shell-quote.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';

let projectDir: string;
let shimDir: string;
let service: ReturnType<typeof createDetectionService>;
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  resetAllStores();
  projectDir = createTempDir('e2e-opencode-cache-project');
  shimDir = createTempDir('e2e-opencode-cache-shim');
  trustHome = useTrustHome('e2e-opencode-cache-home');
  service = createDetectionService();
  vi.stubEnv('PATH', shimDir);
  vi.stubGlobal('fetch', async () => {
    throw new Error('Network disabled in OpenCode model cache e2e');
  });
});

afterEach(async () => {
  await service.shutdown();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  trustHome.restore();
  resetAllStores();
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

describe('e2e: OpenCode model cache', () => {
  it('merges new rows and removes a cached row only after two consecutive absences', async () => {
    const responsePath = join(shimDir, 'response.json');
    const shimPath = join(shimDir, 'opencode');
    // OpenCode is on BUILD, so the shim answers only a listing that names the project.
    writeFileSync(
      shimPath,
      `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf '%s\\n' '2.0.26'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"name":"p","connections":[{"type":"credential"}]}]'
  exit 0
fi
if [ "$#" -eq 6 ] && [ "$1" = "api" ] && [ "$2" = "GET" ] && [ "$3" = "/api/model" ] && [ "$4" = "--standalone" ] && [ "$5" = "-H" ] && [ "$6" = ${shellQuoteArg(`x-opencode-directory:${encodeURIComponent(projectDir)}`)} ]; then
  exec /bin/cat ${shellQuoteArg(responsePath)}
fi
printf 'Unexpected opencode arguments: %s\\n' "$*" >&2
exit 1
`,
      'utf8',
    );
    chmodSync(shimPath, 0o755);
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: '/bin/cat' },
        implementer: { kind: 'cli', tool: 'opencode', contextLength: 32_768 },
      }),
    );
    const config = loadConfig(projectDir).config;
    const steps = [
      { label: '1: cold empty', read: [], held: [], state: 'stale', missingOnce: undefined },
      {
        label: '2: full catalog',
        read: ['m1', 'm2', 'm3'],
        held: ['p/m1', 'p/m2', 'p/m3'],
        state: 'fresh',
        missingOnce: undefined,
      },
      {
        label: '3: one empty read',
        read: [],
        held: ['p/m1', 'p/m2', 'p/m3'],
        state: 'stale',
        missingOnce: ['p/m1', 'p/m2', 'p/m3'],
      },
      {
        label: '4: add m4 and clear absence',
        read: ['m1', 'm2', 'm3', 'm4'],
        held: ['p/m1', 'p/m2', 'p/m3', 'p/m4'],
        state: 'fresh',
        missingOnce: undefined,
      },
      {
        label: '5: first m2 absence',
        read: ['m1', 'm3', 'm4'],
        held: ['p/m1', 'p/m3', 'p/m4', 'p/m2'],
        state: 'stale',
        missingOnce: ['p/m2'],
      },
      {
        label: '6: second m2 absence',
        read: ['m1', 'm3', 'm4'],
        held: ['p/m1', 'p/m3', 'p/m4'],
        state: 'fresh',
        missingOnce: undefined,
      },
      {
        label: '7: first consecutive empty read',
        read: [],
        held: ['p/m1', 'p/m3', 'p/m4'],
        state: 'stale',
        missingOnce: ['p/m1', 'p/m3', 'p/m4'],
      },
      {
        label: '8: second consecutive empty read',
        read: [],
        held: [],
        state: 'stale',
        missingOnce: undefined,
      },
    ];

    for (const step of steps) {
      writeFileSync(
        responsePath,
        JSON.stringify({
          data: step.read.map((id) => ({ providerID: 'p', id, name: id.toUpperCase() })),
        }),
      );
      await refreshPickerDetection(projectDir, () =>
        refreshDetectionForCurrentConfig({
          service,
          publication: detectionStore,
          getCurrent: () => ({ config, projectDir }),
        }),
      );
      await service.getPendingSave();

      const runtime = modelCacheStore.getCliCatalogRuntime({ tool: 'opencode' });
      if (runtime === undefined || runtime === null) {
        throw new Error(`step ${step.label}: expected a runtime catalog`);
      }
      expect
        .soft(
          {
            state: runtime.state,
            models: runtime.models?.map((model) => model.id),
            missingOnce: runtime.missingOnce,
          },
          `step ${step.label}: runtime catalog`,
        )
        .toEqual({ state: step.state, models: step.held, missingOnce: step.missingOnce });
      expect.soft(runtime, `step ${step.label}: successful read`).not.toHaveProperty('failure');

      const snapshot = await loadRememberedSnapshot(projectDir);
      if (snapshot === null) throw new Error(`step ${step.label}: expected a disk cache`);
      const remembered = snapshot.cliCatalogs?.find((catalog) => catalog.tool === 'opencode');
      if (remembered === undefined) {
        throw new Error(`step ${step.label}: expected a remembered catalog`);
      }
      expect
        .soft(
          {
            models: remembered.models.map((model) => model.id),
            missingOnce: remembered.missingOnce,
          },
          `step ${step.label}: disk catalog`,
        )
        .toEqual({ models: step.held, missingOnce: step.missingOnce });
    }
  }, 20_000);
});

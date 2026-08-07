import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { CliToolDetection, ProviderDetection } from '../core/discovery/detection.js';
import { initStores } from './init-stores.js';
import { configStore } from '../stores/project/config.js';
import { detectionStore } from '../stores/project/detection.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { skillsStore } from '../stores/project/skills.js';
import { SPLITBRIEF_DIR } from '../core/paths.js';
import { toYaml } from '../core/config/load/transform.js';
import { createDefaultConfig } from '../core/config/load/io.js';
import { detectCapabilities } from '../engine/providers/capabilities.js';
import * as capabilitiesModule from '../engine/providers/capabilities.js';
import { loadDetectionCacheSnapshot, saveDetectionCache } from '../engine/detection/cache.js';
import * as detectionServiceModule from '../engine/detection/service.js';
import * as modelsDevCacheModule from '../engine/providers/models-dev-cache.js';
import type { ModelsDevCatalogSnapshot } from '../engine/providers/models-dev-cache.js';
import { modelCacheStore } from '../stores/discovery/model-cache.js';
import { detectionContextsForCurrentConfig } from '../engine/detection/store-publication.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';

// Bootstrap runs real disk reads + provider-detection probes. HTTP probes return
// empty responses so this file never contacts a live provider.
setupFetchMock();

let tmp: string;
let savedContextLengthEnv: string | undefined;

function requireConfig() {
  const state = configStore.get();
  if (!state.config) throw new Error('Expected configStore.config to be loaded');
  return state.config;
}

function makeProjectDir(
  detection: { providers: ProviderDetection[]; cliTools: CliToolDetection[] } = {
    providers: [],
    cliTools: [],
  },
): string {
  tmp = createTempDir('init-stores-test');
  const splitbriefDir = join(tmp, SPLITBRIEF_DIR);
  mkdirSync(splitbriefDir, { recursive: true });
  writeFileSync(
    join(splitbriefDir, 'detection-cache.json'),
    JSON.stringify({ version: 2, timestamp: Date.now(), ...detection }),
    'utf-8',
  );
  return tmp;
}

beforeEach(() => {
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}', { status: 200 }));
  savedContextLengthEnv = process.env.SPLITBRIEF_CONTEXT_LENGTH;
  delete process.env.SPLITBRIEF_CONTEXT_LENGTH;
  resetAllStores();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAllStores();
  if (savedContextLengthEnv === undefined) delete process.env.SPLITBRIEF_CONTEXT_LENGTH;
  else process.env.SPLITBRIEF_CONTEXT_LENGTH = savedContextLengthEnv;
  if (tmp) cleanupTempDir(tmp);
});

const rememberedCatalog: ModelsDevCatalogSnapshot = {
  sourceUrl: 'https://models.dev/api.json',
  parserVersion: 'models-dev-api-json-v1',
  catalog: { anthropic: { id: 'anthropic', models: { 'claude-opus-5': { id: 'claude-opus-5' } } } },
  catalogState: 'populated',
  fetchedAt: 1_700_000_000_000,
  validatedAt: 1_700_000_000_500,
};

describe('initStores', () => {
  it('issues the models.dev catalog seed before the background refresh begins', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
    );

    const calls: string[] = [];
    const catalogRead = Promise.withResolvers<ModelsDevCatalogSnapshot | null>();
    vi.spyOn(modelsDevCacheModule, 'loadModelsDevCatalogCache').mockImplementation(() => {
      calls.push('models-dev-cache');
      return catalogRead.promise;
    });
    const loadDetection = vi.fn(async () => {
      calls.push('load-detection');
      return { providers: [], cliTools: [], catalog: null, cliModels: [] };
    });
    vi.spyOn(detectionServiceModule, 'getDefaultDetectionService').mockReturnValue({
      loadDetection,
      refreshDetection: vi.fn(),
    });

    await initStores(dir);

    expect(calls).toEqual(['models-dev-cache', 'load-detection']);
    // The seed is never awaited, so boot completes while the read is pending.
    expect(modelCacheStore.getModelsDevCatalog()).toBeNull();

    catalogRead.resolve(rememberedCatalog);
    await vi.waitFor(() =>
      expect(modelCacheStore.getModelsDevCatalog()).toEqual(rememberedCatalog.catalog),
    );
    expect(modelCacheStore.get().modelsDevFetchedAt).toBe(rememberedCatalog.fetchedAt);
  }, 30_000);

  it('publishes remembered detection before background refresh settles', async () => {
    const dir = makeProjectDir();
    const config = {
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
    } as const;
    writeConfigYaml(dir, toYaml(config));

    const rememberedCli = cliDetectionFor('ready', 'claude-code');
    const capabilities = Promise.withResolvers<Awaited<ReturnType<typeof detectCapabilities>>>();
    vi.spyOn(capabilitiesModule, 'detectCapabilities').mockReturnValue(capabilities.promise);

    const backgroundRefresh =
      Promise.withResolvers<detectionServiceModule.DetectionServiceResult>();
    let refreshSettled = false;
    const refresh = backgroundRefresh.promise.finally(() => {
      refreshSettled = true;
    });
    const loadDetection = vi.fn(
      async ({ deps, onLane }: detectionServiceModule.DetectionLoadInput) => {
        const result = await refresh;
        onLane?.({
          lane: 'readiness',
          outcome: {
            kind: 'fresh',
            origin: 'request',
            snapshot: {
              source: 'readiness',
              contextKey: deps.sourceContexts?.readiness ?? 'missing-readiness-context',
              generation: 4,
              requestId: 8,
              fetchedAt: 200,
              validatedAt: 200,
              stale: false,
              value: { providers: result.providers, cliTools: result.cliTools },
            },
          },
        });
        return result;
      },
    );
    vi.spyOn(detectionServiceModule, 'getDefaultDetectionService').mockReturnValue({
      loadDetection,
      refreshDetection: vi.fn(),
    });

    const initialization = initStores(dir);
    await vi.waitFor(() => expect(configStore.get().config).not.toBeNull());
    const contexts = detectionContextsForCurrentConfig({
      config: requireConfig(),
      projectDir: dir,
    });
    expect(contexts.readiness.length).toBeGreaterThan(512);
    await saveDetectionCache({
      projectDir: dir,
      snapshot: {
        contextKey: contexts.readiness,
        fetchedAt: 100,
        validatedAt: 110,
        generation: 3,
        requestId: 7,
        providers: [{ provider: 'ollama', available: true, isLocal: true }],
        cliTools: [rememberedCli],
      },
    });
    expect(
      await loadDetectionCacheSnapshot({ projectDir: dir, contextKey: contexts.readiness }),
    ).not.toBeNull();
    capabilities.resolve({ contextLength: 32_768, origin: 'fallback' });
    await vi.waitFor(() => expect(loadDetection).toHaveBeenCalledOnce());

    const remembered = detectionStore.get();
    expect(remembered.refresh.readiness).toMatchObject({
      outcome: 'stale',
      refreshing: true,
      fetchedAt: 100,
      validatedAt: 110,
    });
    expect(remembered.providers).toEqual([{ provider: 'ollama', available: true, isLocal: true }]);
    expect(remembered.cliTools).toEqual([
      {
        ...rememberedCli,
        executable: null,
      },
    ]);

    await initialization;
    expect(refreshSettled).toBe(false);

    backgroundRefresh.resolve({ providers: [], cliTools: [], catalog: null, cliModels: [] });
    await vi.waitFor(() => expect(refreshSettled).toBe(true));
    await vi.waitFor(() => expect(detectionStore.get().refresh.readiness.outcome).toBe('fresh'));
  }, 30_000);

  it('loads config from disk into configStore (cli planner / cli implementer)', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'claude-sonnet-4-6',
        },
      }),
    );

    await initStores(dir);

    expect(configStore.get().projectDir).toBe(dir);
    const config = requireConfig();
    expect(config.planner.kind).toBe('cli');
    expect(config.implementer.kind).toBe('cli');
  }, 30_000);

  it('does not project a detection cache entry without active-runner context during boot', async () => {
    const providers: ProviderDetection[] = [
      {
        provider: 'ollama',
        available: true,
        isLocal: true,
        models: [{ id: 'contextless-cache-only-model' }],
      },
    ];
    const cliTools: CliToolDetection[] = [
      cliDetectionFor('ready', 'claude-code', {
        installedVersion: 'contextless-cache-only-version',
      }),
    ];
    const dir = makeProjectDir({ providers, cliTools });

    await initStores(dir);

    expect(
      detectionStore
        .get()
        .cliTools.some((tool) => tool.installedVersion === cliTools[0]?.installedVersion),
    ).toBe(false);
    expect(
      detectionStore
        .get()
        .providers.flatMap((provider) => provider.models ?? [])
        .some((model) => model.id === 'contextless-cache-only-model'),
    ).toBe(false);
  }, 30_000);

  it('falls back to default config when no config file exists on disk', async () => {
    const dir = makeProjectDir();
    // No config.yaml written.

    await initStores(dir);

    const config = requireConfig();
    // Defaults: planner is cli/claude-code, implementer is api/ollama.
    expect(config.planner.kind).toBe('cli');
    expect(config.implementer.kind).toBe('api');
  }, 30_000);

  it('applies CLI-override workflow mode on top of loaded config', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
    );

    await initStores(dir, { mode: 'quick' });

    expect(configStore.get().config?.workflow.mode).toBe('quick');
  }, 30_000);

  it('populates sessionsStore.sessions from the on-disk session directory', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
    );

    // Create a session on disk with a valid summary.json matching SessionSchema.
    const sessionId = '2026-04-18-bootstrap-test';
    const sDir = join(dir, SPLITBRIEF_DIR, 'sessions', sessionId);
    mkdirSync(sDir, { recursive: true });
    const session = {
      id: sessionId,
      feature: 'bootstrap test',
      startedAt: Date.parse('2026-04-18T10:00:00.000Z'),
      completedAt: Date.parse('2026-04-18T10:05:00.000Z'),
      stateVersion: 1,
      status: 'complete',
      summary: {
        feature: 'bootstrap test',
        totalTasks: 0,
        completedByLocal: 0,
        escalatedToPlanner: 0,
        skipped: 0,
        failed: 0,
        totalTime: 0,
        tokenUsage: {
          plannerInput: 0,
          plannerOutput: 0,
          implementerInput: 0,
          implementerOutput: 0,
          escalationInput: 0,
          escalationOutput: 0,
        },
        estimatedCostSavings: '$0.00',
        escalationRate: 0,
      },
    };
    writeFileSync(join(sDir, 'summary.json'), JSON.stringify(session));

    await initStores(dir);

    const sessions = sessionsStore.get().sessions;
    expect(sessions.some((s) => s.id === sessionId)).toBe(true);
  }, 30_000);

  it('sessionsStore ends up with an empty list when no sessions exist on disk', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
    );

    await initStores(dir);

    expect(sessionsStore.get().sessions).toEqual([]);
  }, 30_000);

  it('discovers a project-local Claude skill into skillsStore.available', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
    );
    const skillDir = join(dir, '.claude', 'skills', 'bootstrap-proof');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
id: bootstrap-proof
name: bootstrap-proof
description: proves initStores discovers project skills
---
Skill body for bootstrap proof.
`,
      'utf-8',
    );

    await initStores(dir);

    expect(skillsStore.get().available.some((skill) => skill.id === 'bootstrap-proof')).toBe(true);
  }, 30_000);

  it('overrides implementer model from opts.implementerModel', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
    );

    await initStores(dir, { implementerModel: 'claude-opus-4-5' });

    expect(requireConfig().implementer.model).toBe('claude-opus-4-5');
  }, 30_000);

  it('repeated bootstrap does not accumulate resize listeners', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
    );
    const before = process.stdout.listenerCount('resize');

    await initStores(dir);
    await initStores(dir);

    expect(process.stdout.listenerCount('resize')).toBe(before + 1);
  }, 30_000);

  it('preserves an explicitly configured implementer contextLength through boot', async () => {
    const savedEnv = process.env.SPLITBRIEF_CONTEXT_LENGTH;
    delete process.env.SPLITBRIEF_CONTEXT_LENGTH;
    try {
      const dir = makeProjectDir();
      writeConfigYaml(
        dir,
        toYaml({
          ...createDefaultConfig(),
          planner: { kind: 'cli', tool: 'claude-code' },
          implementer: {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen:7b',
            contextLength: 16384,
          },
        }),
      );

      await initStores(dir);

      // Provider detection during boot must not overwrite an explicitly configured value.
      expect(requireConfig().implementer.contextLength).toBe(16384);
      // An explicit value is not boot-detected, so context routing must not label it 'detected'.
      expect(configStore.getDetectedContextLength()).toBeUndefined();
    } finally {
      if (savedEnv === undefined) delete process.env.SPLITBRIEF_CONTEXT_LENGTH;
      else process.env.SPLITBRIEF_CONTEXT_LENGTH = savedEnv;
    }
  }, 30_000);

  it('does not push a fallback-origin context length into the store', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5.4-mini' },
      }),
    );

    await initStores(dir);

    expect(requireConfig().implementer.contextLength).toBeUndefined();
    expect(configStore.getDetectedContextLength()).toBeUndefined();
  }, 30_000);

  it('pushes a real codex/auto window into the store without rewriting config.yaml', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'codex', model: 'auto' },
      }),
    );
    const configPath = join(dir, SPLITBRIEF_DIR, 'config.yaml');
    const before = readFileSync(configPath, 'utf-8');

    await initStores(dir);

    expect(requireConfig().implementer.contextLength).toBe(1_050_000);
    expect(configStore.getDetectedContextLength()).toBe(1_050_000);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  }, 30_000);

  it('pushes a live-detected context length with detected=true', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(
      dir,
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen3-coder:30b',
        },
      }),
    );
    vi.mocked(globalThis.fetch).mockImplementation(
      async () => new Response(JSON.stringify({ parameters: 'num_ctx 262144' }), { status: 200 }),
    );

    await initStores(dir);

    expect(requireConfig().implementer.contextLength).toBe(262_144);
    expect(configStore.getDetectedContextLength()).toBe(262_144);
    expect(configStore.get().config?.implementer.contextLength).toBe(262_144);
  }, 30_000);

  it('fresh default config with no live provider does not claim a static local context limit', async () => {
    const dir = makeProjectDir();
    const caps = await detectCapabilities(createDefaultConfig());

    expect(caps).toEqual({ contextLength: 32768, origin: 'fallback' });

    await initStores(dir);

    expect(requireConfig().implementer.model).toBe('qwen3-coder:30b');
    expect(requireConfig().implementer.contextLength).toBeUndefined();
    expect(configStore.getDetectedContextLength()).toBeUndefined();
  }, 30_000);

  it('throws a CLI error when config loading yields no config state', async () => {
    const dir = makeProjectDir();
    // Write a config that is valid YAML but structurally malformed enough
    // that loadConfig raises. An unknown planner tool triggers schema error.
    writeFileSync(
      join(dir, SPLITBRIEF_DIR, 'config.yaml'),
      YAML.stringify({
        version: 3,
        planner: { kind: 'cli', tool: 'not-a-real-tool' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
      'utf-8',
    );

    await expect(initStores(dir)).rejects.toThrow();
  }, 30_000);
});

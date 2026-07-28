import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { initStores } from './init-stores.js';
import { configStore } from '../stores/project/config.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { skillsStore } from '../stores/project/skills.js';
import { SPLITBRIEF_DIR } from '../core/paths.js';
import { toYaml } from '../core/config/load/transform.js';
import { createDefaultConfig } from '../core/config/load/io.js';
import { detectCapabilities } from '../engine/providers/capabilities.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { writeEmptyDetectionCache } from '#testing/helpers/write-empty-detection-cache.js';

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

// Seed a fresh detection cache so loadDetection() serves from disk and never
// spawns the CLI-tool / network provider probes during boot. Each test gets a
// unique temp projectDir, so without this every initStores() call would re-run
// the full detection sweep (subprocess spawns + provider HTTP), which starves
// this file under full-suite parallelism and trips the test timeout.
function makeProjectDir(): string {
  tmp = createTempDir('init-stores-test');
  writeEmptyDetectionCache(tmp);
  return tmp;
}

beforeEach(() => {
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}', { status: 200 }));
  savedContextLengthEnv = process.env.SPLITBRIEF_CONTEXT_LENGTH;
  delete process.env.SPLITBRIEF_CONTEXT_LENGTH;
  resetAllStores();
});

afterEach(() => {
  resetAllStores();
  if (savedContextLengthEnv === undefined) delete process.env.SPLITBRIEF_CONTEXT_LENGTH;
  else process.env.SPLITBRIEF_CONTEXT_LENGTH = savedContextLengthEnv;
  if (tmp) cleanupTempDir(tmp);
});

describe('initStores', () => {
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

  it('pushes a catalog-origin context length with detected=true', async () => {
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

    await initStores(dir);

    expect(requireConfig().implementer.contextLength).toBe(262_144);
    expect(configStore.getDetectedContextLength()).toBe(262_144);
  }, 30_000);

  it("fresh default config with no live provider resolves origin 'catalog' with 262144 from the bundled qwen3-coder:30b entry", async () => {
    const dir = makeProjectDir();
    const caps = await detectCapabilities(createDefaultConfig());

    expect(caps).toEqual({ contextLength: 262_144, origin: 'catalog' });

    await initStores(dir);

    expect(requireConfig().implementer.model).toBe('qwen3-coder:30b');
    expect(requireConfig().implementer.contextLength).toBe(262_144);
    expect(configStore.getDetectedContextLength()).toBe(262_144);
  }, 30_000);

  it('throws a CLI error when config loading yields no config state', async () => {
    const dir = makeProjectDir();
    // Write a config that is valid YAML but structurally malformed enough
    // that loadConfig raises. An unknown planner tool triggers schema error.
    writeFileSync(
      join(dir, SPLITBRIEF_DIR, 'config.yaml'),
      YAML.stringify({
        version: 2,
        planner: { kind: 'cli', tool: 'not-a-real-tool' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
      'utf-8',
    );

    await expect(initStores(dir)).rejects.toThrow();
  }, 30_000);
});

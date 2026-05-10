import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { resetAllStores } from '#testing/helpers/stores.js';
import { initStores } from './init-stores.js';
import { configStore } from '../stores/project/config.js';
import { sessionsStore } from '../stores/project/sessions.js';
import { skillsStore } from '../stores/project/skills.js';
import { DIPTYCH_DIR } from '../core/paths.js';
import { toYaml } from '../core/config/load/transform.js';
import { createDefaultConfig } from '../core/config/load/load.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

// Bootstrap runs real disk reads + provider-detection probes. Probes fail
// fast with no servers running and land in the `catch { return [] }` branches.

let tmp: string;

function requireConfig() {
  const state = configStore.get();
  if (!state.config) throw new Error('Expected configStore.config to be loaded');
  return state.config;
}

function makeProjectDir(): string {
  tmp = createTempDir('init-stores-test');
  mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
  return tmp;
}

function writeConfigYaml(projectDir: string, obj: Record<string, unknown>): void {
  const file = join(projectDir, DIPTYCH_DIR, 'config.yaml');
  writeFileSync(file, YAML.stringify(obj), 'utf-8');
}

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  resetAllStores();
  if (tmp) cleanupTempDir(tmp);
});

describe('initStores', () => {
  it('loads config from disk into configStore (cli planner / cli implementer)', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(dir, toYaml({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'claude-sonnet-4-6',
      },
    }));

    await initStores(dir);

    expect(configStore.get().projectDir).toBe(dir);
    const config = requireConfig();
    expect(config.planner.kind).toBe('cli');
    expect(config.implementer.kind).toBe('cli');
  }, 15_000);

  it('falls back to default config when no config file exists on disk', async () => {
    const dir = makeProjectDir();
    // No config.yaml written.

    await initStores(dir);

    const config = requireConfig();
    // Defaults: planner is cli/claude-code, implementer is api/ollama.
    expect(config.planner.kind).toBe('cli');
    expect(config.implementer.kind).toBe('api');
  }, 15_000);

  it('applies CLI-override workflow mode on top of loaded config', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(dir, toYaml({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
    }));

    await initStores(dir, { mode: 'quick' });

    expect(configStore.get().config?.workflow.mode).toBe('quick');
  }, 15_000);

  it('populates sessionsStore.sessions from the on-disk session directory', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(dir, toYaml({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
    }));

    // Create a session on disk with a valid summary.json matching SessionSchema.
    const sessionId = '2026-04-18-bootstrap-test';
    const sDir = join(dir, DIPTYCH_DIR, 'sessions', sessionId);
    mkdirSync(sDir, { recursive: true });
    const session = {
      id: sessionId,
      feature: 'bootstrap test',
      startedAt: Date.parse('2026-04-18T10:00:00.000Z'),
      completedAt: Date.parse('2026-04-18T10:05:00.000Z'),
      stateVersion: 1,
      stateFile: null,
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
    expect(sessions.some(s => s.id === sessionId)).toBe(true);
  }, 15_000);

  it('sessionsStore ends up with an empty list when no sessions exist on disk', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(dir, toYaml({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
    }));

    await initStores(dir);

    expect(sessionsStore.get().sessions).toEqual([]);
  }, 15_000);

  it('skillsStore is populated (possibly empty) after bootstrap completes', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(dir, toYaml({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
    }));

    await initStores(dir);

    // Contract: skillsStore.available is an array after initStores resolves.
    // Content depends on developer's `~/.claude/skills` + project `.claude/skills`;
    // the contract is that it was discovered, not that it is non-empty.
    expect(Array.isArray(skillsStore.get().available)).toBe(true);
  }, 15_000);

  it('overrides implementer model from opts.implementerModel', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(dir, toYaml({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
    }));

    await initStores(dir, { implementerModel: 'claude-opus-4-5' });

    expect(requireConfig().implementer.model).toBe('claude-opus-4-5');
  }, 15_000);

  it('resolves before returning (all awaited side-effects settle)', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(dir, toYaml({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
    }));

    await initStores(dir);

    expect(configStore.get().config).not.toBeNull();
    expect(sessionsStore.get().sessions).toBeDefined();
    expect(skillsStore.get().available).toBeDefined();
  }, 15_000);

  it('repeated bootstrap does not accumulate resize listeners', async () => {
    const dir = makeProjectDir();
    writeConfigYaml(dir, toYaml({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
    }));
    const before = process.stdout.listenerCount('resize');

    await initStores(dir);
    await initStores(dir);

    expect(process.stdout.listenerCount('resize')).toBe(before + 1);
  }, 15_000);

  it('throws a CLI error when config loading yields no config state', async () => {
    const dir = makeProjectDir();
    // Write a config that is valid YAML but structurally malformed enough
    // that loadConfig raises. An unknown planner tool triggers schema error.
    writeFileSync(
      join(dir, DIPTYCH_DIR, 'config.yaml'),
      YAML.stringify({
        version: 2,
        planner: { kind: 'cli', tool: 'not-a-real-tool' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4-6' },
      }),
      'utf-8',
    );

    await expect(initStores(dir)).rejects.toThrow();
  }, 15_000);
});

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_PROVIDER_CATALOG } from '../../src/core/providers/api-provider-catalog.js';
import { AUTOMATIC_MODEL, isAutomaticModel } from '../../src/core/providers/automatic-model.js';
import {
  createDefaultConfig,
  initConfig,
  loadConfig,
  writeConfig,
} from '../../src/core/config/load/io.js';
import { defaultCliAuthChannel } from '../../src/core/runners/cli-tool-catalog.js';
import type { Config } from '../../src/core/schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { writeConfigYamlText } from '#testing/helpers/config-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const REPO_ROOT = join(import.meta.dirname, '../..');
const EVAL_FIXTURE_ROOT = join(REPO_ROOT, 'evals/fixtures');
const EXAMPLE_CONFIG_ROOT = join(REPO_ROOT, 'testing/fixtures/configs');

// A missing corpus directory is exactly what the vacuity guards below exist to
// report. Listing it eagerly at collection time would throw an ENOENT stack
// trace before any test runs, so an absent root reads as an empty corpus and
// lets the guard state the problem in its own words.
function evalFixtureProjects(): string[] {
  if (!existsSync(EVAL_FIXTURE_ROOT)) return [];
  return readdirSync(EVAL_FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(EVAL_FIXTURE_ROOT, entry.name))
    .filter((dir) => existsSync(join(dir, '.splitbrief/config.yaml')));
}

function exampleConfigFiles(): string[] {
  if (!existsSync(EXAMPLE_CONFIG_ROOT)) return [];
  return readdirSync(EXAMPLE_CONFIG_ROOT).filter((file) => file.endsWith('.yaml'));
}

async function withProject<T>(fn: (projectDir: string) => T | Promise<T>): Promise<T> {
  const dir = createTempDir('shipped-config');
  try {
    return await fn(dir);
  } finally {
    cleanupTempDir(dir);
  }
}

// Credential presence is a property of the machine, not of the artifact under
// test. Stubbing every catalog credential makes the corpus assert config shape
// identically on a laptop with keys and on a CI runner without any.
beforeAll(() => {
  for (const descriptor of Object.values(API_PROVIDER_CATALOG)) {
    if (!descriptor.credentialEnv) continue;
    vi.stubEnv(descriptor.credentialEnv, `${descriptor.credentialPrefix ?? ''}shipped-config-test`);
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('committed eval fixture configs', () => {
  const projects = evalFixtureProjects();

  it('ships at least one fixture project so the corpus is never vacuous', () => {
    expect(projects.length).toBeGreaterThan(0);
  });

  it.each(projects)('loads %s through the real loader', (projectDir) => {
    const result = loadConfig(projectDir);
    expect(result.warnings).toEqual([]);
    expect(result.config.version).toBe(3);
  });
});

describe('committed example configs', () => {
  const files = exampleConfigFiles();

  async function loadExample(file: string): Promise<Config> {
    const text = readFileSync(join(EXAMPLE_CONFIG_ROOT, file), 'utf-8');
    return withProject((projectDir) => {
      writeConfigYamlText(projectDir, text);
      const result = loadConfig(projectDir);
      expect(result.warnings, file).toEqual([]);
      return result.config;
    });
  }

  it('ships at least one example config', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('loads %s through the real loader', async (file) => {
    expect((await loadExample(file)).version).toBe(3);
  });

  it('covers both CLI model spellings the loader must accept', async () => {
    const configs: Config[] = [];
    for (const file of files) configs.push(await loadExample(file));
    const cliPlannerModels = configs
      .map((config) => config.planner)
      .flatMap((planner) => (planner.kind === 'cli' ? [planner.model] : []))
      .filter((model): model is string => model !== undefined);

    expect(cliPlannerModels).toContain(AUTOMATIC_MODEL);
    expect(cliPlannerModels.some((model) => !isAutomaticModel(model))).toBe(true);
  });
});

describe('the product writes what the product reads', () => {
  it('loads back exactly what initConfig writes', async () => {
    await withProject(async (projectDir) => {
      await initConfig(projectDir);
      const result = loadConfig(projectDir);
      expect(result.warnings).toEqual([]);
      expect(result.config).toStrictEqual(createDefaultConfig());
    });
  });

  it('loads back exactly what writeConfig writes for the default config', async () => {
    await withProject((projectDir) => {
      writeConfig(projectDir, createDefaultConfig());
      expect(loadConfig(projectDir).config).toStrictEqual(createDefaultConfig());
    });
  });
});

describe('the test config factory tracks the product writer', () => {
  it('builds the default planner the product writer emits, field for field', () => {
    expect(makeConfig().planner).toStrictEqual(createDefaultConfig().planner);
  });

  it('names an explicit Claude Code channel while preserving unset channels in fixtures', () => {
    const cliImplementer = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer;
    expect(makeConfig().planner).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    });
    expect(Object.hasOwn(cliImplementer, 'authChannel')).toBe(false);
  });
});

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  cleanupStartReadinessDirs,
  cliEvidence,
  executable,
  projectWithConfig,
} from '#testing/helpers/start-readiness.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { CliProviderAuth } from '../core/discovery/detection/auth.js';
import { deriveCliReadiness } from '../core/readiness/cli-remediation.js';
import { CLI_TOOL_CATALOG } from '../core/runners/cli-tool/catalog.js';
import { saveDetectionCache } from '../engine/detection/cache/store.js';
import { detectRunnerEvidence } from '../engine/detection/runner-evidence/detect.js';
import { detectConfiguredCliReadiness, readConfiguredCliRoutes } from './configured-readiness.js';

// The fresh model-list read spawns the tool; each case sees only the read it answers.
vi.mock('../engine/detection/runner-evidence/detect.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../engine/detection/runner-evidence/detect.js')>();
  return { ...original, detectRunnerEvidence: vi.fn(original.detectRunnerEvidence) };
});

const directories: string[] = [];

// A cli seat with no model makes preparation read the model the tool selected on this host, so
// each case gets a host holding only what it wrote there.
beforeEach(() => {
  const home = createTempDir('start-preparation-home');
  directories.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
});

afterEach(() => {
  vi.mocked(detectRunnerEvidence).mockReset();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
  cleanupStartReadinessDirs();
});

describe('detectConfiguredCliReadiness', () => {
  it('probes the CLI reviewer even when no other seat is a CLI runner', async () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.test/v1',
        model: 'some-model',
      },
      reviewer: { kind: 'cli', tool: 'opencode' },
    });

    const results = await detectConfiguredCliReadiness({
      projectDir: process.cwd(),
      config,
      opts: {},
    });

    expect(results.map((result) => result.tool)).toEqual(['opencode']);
  });
});

describe('readConfiguredCliRoutes', () => {
  const LOCAL_ROUTE = { kind: 'cli', tool: 'opencode', model: 'ollama/llama3' } as const;

  function opencodeReadiness(
    providerAuth: CliProviderAuth,
    facts: Partial<Parameters<typeof deriveCliReadiness>[0]> = {},
  ) {
    const testedVersion = CLI_TOOL_CATALOG.opencode.compatibility.testedVersion;
    return deriveCliReadiness({
      tool: 'opencode',
      enabled: true,
      installation: 'installed',
      executable: { path: '/usr/local/bin/opencode', fingerprint: executable.fingerprint },
      trust: 'trusted',
      installedVersion: testedVersion,
      testedVersion,
      compatibility: 'compatible',
      auth: 'unauthenticated',
      providerAuth,
      probedAt: 1,
      ...facts,
    });
  }

  /** OpenCode's model list, read from the tool: by default it serves `ollama/llama3`. */
  function listReads(models: readonly string[] = ['ollama/llama3']): () => number {
    vi.mocked(detectRunnerEvidence).mockImplementation(async ({ context }) => ({
      ...cliEvidence(context),
      runner: { id: 'opencode', kind: 'cli', locality: 'local', enabled: 'enabled' },
      catalog: { kind: 'success', value: models.map((id) => ({ id })) },
    }));
    return () =>
      vi.mocked(detectRunnerEvidence).mock.calls.filter(([input]) => input.includeCatalog === true)
        .length;
  }

  it('reads the list once for two seats whose route no credential covers', async () => {
    const reads = listReads();
    const config = makeConfig({ planner: LOCAL_ROUTE, implementer: LOCAL_ROUTE });

    const routes = await readConfiguredCliRoutes({
      routeCatalogs: new Map(),
      projectDir: projectWithConfig(config),
      config,
      cliReadiness: [opencodeReadiness({ kind: 'empty' })],
    });

    expect(reads()).toBe(1);
    expect(routes.catalogs).toEqual([
      expect.objectContaining({ tool: 'opencode', models: [{ id: 'ollama/llama3' }] }),
    ]);
  });

  /** A list saved before OpenCode joined the crew: its read did not name the project. */
  async function saveUnnamedList(projectDir: string, models: readonly string[]): Promise<void> {
    await saveDetectionCache({
      projectDir,
      snapshot: {
        contextKey: 'remembered',
        fetchedAt: 1,
        validatedAt: 1,
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [],
        cliCatalogs: [{ tool: 'opencode', models: models.map((id) => ({ id })), probedAt: 1 }],
      },
    });
  }

  it('reads no list for a route a saved list serves, also one that did not name the project', async () => {
    const reads = listReads();
    const config = makeConfig({ implementer: LOCAL_ROUTE });
    const projectDir = projectWithConfig(config);
    await saveUnnamedList(projectDir, ['ollama/llama3']);

    const routes = await readConfiguredCliRoutes({
      routeCatalogs: new Map(),
      projectDir,
      config,
      cliReadiness: [opencodeReadiness({ kind: 'empty' })],
    });

    expect(reads()).toBe(0);
    expect(routes.catalogs).toEqual([
      expect.objectContaining({ tool: 'opencode', models: [{ id: 'ollama/llama3' }] }),
    ]);
  });

  it('reads the routes of one tool on two providers against its fresh list, not a saved one that did not name the project', async () => {
    const fresh = ['ollama/llama3', 'ollama-cloud/glm-5'];
    const reads = listReads(fresh);
    const config = makeConfig({
      planner: LOCAL_ROUTE,
      implementer: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/glm-5' },
    });
    const projectDir = projectWithConfig(config);
    await saveUnnamedList(projectDir, ['ollama/llama3']);

    const routes = await readConfiguredCliRoutes({
      routeCatalogs: new Map(),
      projectDir,
      config,
      cliReadiness: [opencodeReadiness({ kind: 'empty' })],
    });

    expect(reads()).toBe(1);
    expect(routes.catalogs).toEqual([{ tool: 'opencode', models: fresh.map((id) => ({ id })) }]);
  });

  it('reads no list when a stored credential covers the route', async () => {
    const reads = listReads();
    const config = makeConfig({ implementer: LOCAL_ROUTE });

    await readConfiguredCliRoutes({
      routeCatalogs: new Map(),
      projectDir: projectWithConfig(config),
      config,
      cliReadiness: [
        opencodeReadiness(
          { kind: 'read', facts: [{ id: 'ollama', provider: 'Ollama', source: 'api' }] },
          { auth: 'authenticated' },
        ),
      ],
    });

    expect(reads()).toBe(0);
  });

  it('reads no list for a tool refused on another fact', async () => {
    const reads = listReads();
    const config = makeConfig({ implementer: LOCAL_ROUTE });

    await readConfiguredCliRoutes({
      routeCatalogs: new Map(),
      projectDir: projectWithConfig(config),
      config,
      cliReadiness: [
        opencodeReadiness(
          { kind: 'empty' },
          { installedVersion: '0.0.1', compatibility: 'incompatible' },
        ),
      ],
    });

    expect(reads()).toBe(0);
  });
});

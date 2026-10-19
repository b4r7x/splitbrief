import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  CliExecutableReceiptSchema,
  type CliProviderAuth,
} from '../../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { sessionDir } from '../../../core/paths.js';
import { deriveCliReadiness } from '../../../core/schemas/readiness.js';
import type { Config } from '../../../core/schemas/config.js';
import { readActive } from '../../../core/sessions/active-pointer.js';
import { prepareNewSession } from '../../../core/sessions/prepare.js';
import { saveDetectionCache } from '../../../engine/detection/cache.js';
import {
  detectRunnerEvidence,
  runnerDiscoveryContextKey,
} from '../../../engine/detection/runner-evidence.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import {
  cliPreparationPolicy,
  detectConfiguredCliReadiness,
  prepareStartExecution,
  readConfiguredCliRoutes,
} from './readiness.js';

// The fresh model-list read spawns the tool; each case sees only the read it answers.
vi.mock('../../../engine/detection/runner-evidence.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../engine/detection/runner-evidence.js')>();
  return { ...original, detectRunnerEvidence: vi.fn(original.detectRunnerEvidence) };
});

const executable = CliExecutableReceiptSchema.parse({
  path: '/usr/local/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/usr/local/bin/codex',
    realPath: '/usr/local/bin/codex',
    platformFileId: '1:2',
    fingerprint: `1:2:3:4:sha256:${'a'.repeat(64)}`,
    resolvedAt: 1,
  },
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
});

function projectWithConfig(config: Config): string {
  const projectDir = createTempDir('start-preparation');
  directories.push(projectDir);
  mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
  writeFileSync(join(projectDir, '.splitbrief', 'config.yaml'), JSON.stringify(config));
  return projectDir;
}

function readyReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
    sections: [
      {
        id: 'runners',
        title: 'Runners',
        checks: [{ id: 'runners.configured', severity: 'ok', summary: 'Configured' }],
      },
    ],
    metadata: {},
  };
}

function cliEvidence(context: Parameters<typeof runnerDiscoveryContextKey>[0]): RunnerEvidence {
  const contextKey = runnerDiscoveryContextKey(context);
  const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
  return {
    runner: { id: 'codex', kind: 'cli', locality: 'local', enabled: 'enabled' },
    context: { key: contextKey, observedAt: 1, source: 'fresh' },
    installation: 'installed',
    executable: { kind: 'trusted', identity: executable.executableIdentity },
    compatibility: { kind: 'compatible', installedVersion: testedVersion, testedVersion },
    credential: 'present',
    auth: 'verified',
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: context.model ?? 'unselected',
      observedAt: 1,
      contextKey,
    },
  };
}

describe('start preparation', () => {
  it('uses one fresh evidence set for readiness and CLI admission', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex' },
      validation: { endChecks: false, testCommand: 'noop' },
    });
    const projectDir = projectWithConfig(config);
    const report = readyReport(projectDir);
    const collect = vi.fn(async () => ({ report, config }));
    const detect = vi.fn(async ({ context }) => cliEvidence(context));
    const prepareSession = vi.fn(() => {
      const ownership = {
        version: 1 as const,
        sessionId: 'prepared-session',
        generation: '11111111-1111-4111-8111-111111111111',
      };
      return {
        kind: 'prepared' as const,
        session: {
          ref: { projectDir, sessionId: ownership.sessionId },
          ownership,
          active: ownership,
        },
      };
    });
    const emit = vi.fn();

    const execution = await prepareStartExecution({
      projectDir,
      feature: 'fresh admission',
      opts: {},
      transport: 'headless',
      emitReadiness: emit,
      prepare: (input) =>
        prepareExecution({
          ...input,
          deps: {
            collectReadiness: collect,
            detectRunnerEvidence: detect,
            resolveCliExecutableAliases: async () => ({
              command: 'codex',
              executable,
              usedFallback: false,
            }),
            prepareNewSession: prepareSession,
            collectArgVectorPreflightChecks: async () => [],
            newPreparationId: () => 'start-preparation',
          },
        }),
    });

    expect(collect).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledOnce();
    expect(prepareSession).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(execution.report);
    expect(execution.gates).toEqual([
      expect.objectContaining({
        kind: 'cli',
        slot: { role: 'planner' },
        preparationId: 'start-preparation',
        executable,
      }),
      expect.objectContaining({
        kind: 'api',
        slot: { role: 'implementer', profile: 'default' },
        preparationId: 'start-preparation',
      }),
    ]);
  });

  it('emits a fresh blocked report without creating a session', async () => {
    const config = makeConfig({
      planner: { kind: 'shell', command: 'true', model: 'shell', contextLength: 32_768 },
    });
    const projectDir = projectWithConfig(config);
    const report = {
      ...readyReport(projectDir),
      status: 'blocked' as const,
      counts: { ok: 0, info: 0, warning: 0, blocker: 1 },
      nextAction: { kind: 'fix-config' as const, label: 'Fix config', reason: 'Blocked' },
    };
    const emit = vi.fn();

    await expect(
      prepareStartExecution({
        projectDir,
        feature: 'blocked admission',
        opts: {},
        transport: 'headless',
        emitReadiness: emit,
        prepare: async () => ({ kind: 'blocked', report }),
      }),
    ).rejects.toMatchObject({ kind: 'cli-error' });
    expect(emit).toHaveBeenCalledWith(report);
  });

  it('rolls back the exact prepared session when readiness emission fails', async () => {
    const config = makeConfig();
    const projectDir = projectWithConfig(config);
    const report = readyReport(projectDir);
    let preparedSessionId: string | undefined;

    await expect(
      prepareStartExecution({
        projectDir,
        feature: 'failed readiness emission',
        opts: {},
        transport: 'headless',
        emitReadiness: () => {
          throw new Error('output stream closed');
        },
        prepare: async () => {
          const prepared = prepareNewSession({
            projectDir,
            feature: 'failed readiness emission',
            config,
            report,
          });
          if (prepared.kind === 'aborted') throw new Error('unexpected aborted preparation');
          preparedSessionId = prepared.session.ref.sessionId;
          return {
            kind: 'prepared',
            execution: {
              purpose: 'new-workflow',
              config,
              sourceConfig: config,
              preparationId: 'readiness-emission-failure',
              report,
              gates: [],
              session: { kind: 'new', ...prepared.session },
              runtime: {
                feature: 'failed readiness emission',
                allowRepoRunners: false,
                allowHooks: false,
              },
            },
          };
        },
      }),
    ).rejects.toThrow('output stream closed');

    expect(preparedSessionId).toBeDefined();
    expect(existsSync(sessionDir(projectDir, preparedSessionId as string))).toBe(false);
    expect(readActive(projectDir)).toBeNull();
  });

  it('keeps entry-point policy differences inside the shared preparation policy', () => {
    expect(
      cliPreparationPolicy({ purpose: 'new-workflow', interaction: 'interactive', opts: {} }),
    ).toMatchObject({
      purpose: 'new-workflow',
      interaction: 'interactive',
      unverifiedAuth: 'disclosed',
    });
    expect(
      cliPreparationPolicy({
        purpose: 'resume',
        interaction: 'headless',
        opts: { allowUnverifiedAuth: true },
      }),
    ).toMatchObject({ purpose: 'resume', interaction: 'headless', unverifiedAuth: 'allowed' });
    expect(
      cliPreparationPolicy({ purpose: 'spec', interaction: 'headless', opts: {} }),
    ).toMatchObject({ purpose: 'spec', interaction: 'headless', unverifiedAuth: 'denied' });
    expect(
      cliPreparationPolicy({ purpose: 'review', interaction: 'headless', opts: {} }),
    ).toMatchObject({ purpose: 'review', interaction: 'headless', unverifiedAuth: 'denied' });
  });
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
      authChannel: 'provider-dependent',
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

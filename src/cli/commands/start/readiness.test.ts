import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { CliExecutableReceiptSchema } from '../../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { sessionDir } from '../../../core/paths.js';
import type { Config } from '../../../core/schemas/config.js';
import { readActive } from '../../../core/sessions/lifecycle.js';
import { prepareNewSession } from '../../../core/sessions/prepare.js';
import { runnerDiscoveryContextKey } from '../../../engine/detection/detect.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution.js';
import { cliPreparationPolicy, prepareStartExecution } from './readiness.js';

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

afterEach(() => {
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
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
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
      transport: 'json',
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
        transport: 'json',
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
        transport: 'json',
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
  });
});

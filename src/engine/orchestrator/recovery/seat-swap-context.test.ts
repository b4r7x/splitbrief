import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getSplitbriefPath } from '../../../core/paths.js';
import { saveDetectionCache } from '../../detection/cache.js';
import { configPath } from '../../../core/config/load/document.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { switchSeatOffer } from './builders/task.js';
import { loadSeatSwapContext, readSeatFallbackOfRecord } from './seat-swap-context.js';
import type { CliProviderAuth } from '../../../core/discovery/detection.js';

const evidence = vi.hoisted(() => ({ detectRunnerEvidence: vi.fn() }));
vi.mock('../../detection/runner-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../detection/runner-evidence.js')>()),
  ...evidence,
}));

let dirs: string[] = [];

/** The project remembers OpenCode with this credential listing and this saved model list. */
async function projectRememberingOpencode(
  name: string,
  providerAuth: CliProviderAuth,
  models: readonly string[],
): Promise<string> {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  mkdirSync(getSplitbriefPath(projectDir), { recursive: true });
  await saveDetectionCache({
    projectDir,
    snapshot: {
      contextKey: 'readiness-remembered',
      fetchedAt: Date.now(),
      validatedAt: Date.now(),
      generation: 1,
      requestId: 1,
      providers: [],
      cliTools: [cliDetectionFor('ready', 'opencode', { providerAuth })],
      cliCatalogs: [
        { tool: 'opencode', models: models.map((id) => ({ id })), probedAt: Date.now() },
      ],
    },
  });
  return projectDir;
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  evidence.detectRunnerEvidence.mockReset();
});

async function projectWithRememberedTools(
  name: string,
  cliTools: Parameters<typeof rememberDetectedTools>[1],
): Promise<string> {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  await rememberDetectedTools(projectDir, cliTools);
  return projectDir;
}

describe('loadSeatSwapContext', () => {
  it('returns a read failure for invalid config instead of throwing', () => {
    const projectDir = createTempDir('seat-fallback-invalid-config');
    dirs.push(projectDir);
    const config = makeConfig();
    writeConfig(projectDir, config);
    writeFileSync(configPath(projectDir), 'version: 3\nplanner:\n  kind: cli\n  tool: invalid\n');
    expect(readSeatFallbackOfRecord({ projectDir, seat: 'build', config })).toEqual({
      kind: 'read-failed',
    });
  });

  it('reads the single BUILD fallback when a halt carries a former profile name', async () => {
    const projectDir = await projectWithRememberedTools('seat-fallback-former-profile', [
      cliDetectionFor('ready', 'claude-code'),
    ]);
    const runner = { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } } as const;
    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner,
      config: makeConfig({ implementer: runner }),
      implementerProfile: 'former-profile',
    });
    expect(context?.fallback).toEqual(runner.fallback);
  });

  it("reads the seat's route against its own tool's credential listing, which tells a route sign-out from a model it cannot run", async () => {
    const projectDir = await projectRememberingOpencode(
      'seat-swap-provider-auth',
      { kind: 'read', facts: [{ provider: 'OpenCode Go', source: 'api' }] },
      ['opencode-go/kimi-k3'],
    );
    const runner = {
      kind: 'cli',
      tool: 'opencode',
      model: 'ollama-cloud/deepseek-v4.1-flash',
    } as const;

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner,
      config: makeConfig({ implementer: runner }),
    });

    expect(context?.routeAuth).toEqual({
      kind: 'needs-sign-in',
      tool: 'opencode',
      provider: 'ollama-cloud',
    });
  });

  it('reads the remembered tools regardless of the context they were probed under', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-remembered', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex' },
      config: makeConfig(),
    });

    expect(context).toEqual({
      seat: 'build',
      currentTool: 'codex',
      detectedTools: [
        { tool: 'codex', ready: true },
        { tool: 'claude-code', ready: true },
      ],
      routeAuth: { kind: 'unchecked' },
    });
    expect(switchSeatOffer(context)).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code' }],
    });
  });

  it('marks a tool that is not ready so the offer drops it', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-unready', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unavailable', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex' },
      config: makeConfig(),
    });

    expect(context?.detectedTools).toContainEqual({ tool: 'claude-code', ready: false });
    expect(switchSeatOffer(context)).toBeUndefined();
  });

  it('leaves currentTool empty for a seat no CLI tool hosts', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-api-seat', [
      cliDetectionFor('ready', 'codex'),
    ]);

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner: makeConfig().implementer,
      config: makeConfig(),
    });

    expect(context?.currentTool).toBe('');
    expect(switchSeatOffer(context)).toEqual({ seat: 'build', candidates: [{ tool: 'codex' }] });
  });

  it('offers no other tool when the project has no remembered detection, and keeps the route', async () => {
    const projectDir = createTempDir('seat-swap-no-cache');
    dirs.push(projectDir);

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex' },
      config: makeConfig(),
    });

    expect(context).toEqual({
      seat: 'build',
      currentTool: 'codex',
      detectedTools: [],
      routeAuth: { kind: 'unchecked' },
    });
    expect(switchSeatOffer(context)).toBeUndefined();
  });

  it("reads a route the tool's saved model list serves as configured", async () => {
    const projectDir = createTempDir('seat-swap-remembered-catalog');
    dirs.push(projectDir);
    mkdirSync(getSplitbriefPath(projectDir), { recursive: true });
    const route = 'ollama-cloud/glm-5';
    await saveDetectionCache({
      projectDir,
      snapshot: {
        contextKey: 'readiness-remembered',
        fetchedAt: Date.now(),
        validatedAt: Date.now(),
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [
          cliDetectionFor('ready', 'opencode', {
            providerAuth: { kind: 'read', facts: [{ provider: 'OpenCode Go', source: 'api' }] },
          }),
        ],
        cliCatalogs: [{ tool: 'opencode', models: [{ id: route }], probedAt: Date.now() }],
      },
    });
    const runner = { kind: 'cli', tool: 'opencode', model: route } as const;

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner,
      config: makeConfig({ implementer: runner }),
    });

    expect(context?.routeAuth).toEqual({ kind: 'configured', source: 'listed' });
  });

  describe('a model refusal re-reads the route fresh', () => {
    const route = 'ollama-cloud/glm-5';
    const runner = { kind: 'cli', tool: 'opencode', model: route } as const;
    const refusal = 'provider.no-route: no route for ollama-cloud/glm-5';
    const signedInToGo: CliProviderAuth = {
      kind: 'read',
      facts: [{ id: 'opencode-go', provider: 'OpenCode Go', source: 'stored' }],
    };
    // Saved before the sign-out: the model list still serves ollama-cloud.
    const staleProject = (name: string) =>
      projectRememberingOpencode(name, signedInToGo, [route, 'opencode-go/kimi-k3']);
    const halt = (
      projectDir: string,
      haltRunner: typeof runner | { kind: 'cli'; tool: 'opencode' },
    ) =>
      loadSeatSwapContext({
        modelCache: undefined,
        projectDir,
        seat: 'build',
        runner: haltRunner,
        config: makeConfig({ implementer: haltRunner }),
        refusal,
      });

    it('reads a sign-out the saved model list predates from the fresh model list', async () => {
      evidence.detectRunnerEvidence.mockResolvedValue({
        providerAuth: signedInToGo,
        catalog: { kind: 'success', value: [{ id: 'opencode-go/kimi-k3' }] },
      });
      const context = await halt(await staleProject('seat-swap-fresh-signed-out'), runner);

      expect(evidence.detectRunnerEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ includeCatalog: true }),
      );
      expect(context?.routeAuth).toEqual({
        kind: 'needs-sign-in',
        tool: 'opencode',
        provider: 'ollama-cloud',
      });
    });

    it('names both causes when the fresh model list cannot be read', async () => {
      evidence.detectRunnerEvidence.mockResolvedValue({
        providerAuth: signedInToGo,
        catalog: { kind: 'command-failed', cause: 'exit 1' },
      });
      const context = await halt(await staleProject('seat-swap-fresh-unread'), runner);

      expect(context?.routeAuth).toEqual({ kind: 'unknown', reason: 'catalog-not-read' });
    });

    it('never reads a tool that stores no credential as signed out when the fresh model list cannot be read', async () => {
      evidence.detectRunnerEvidence.mockResolvedValue({
        providerAuth: { kind: 'empty' },
        catalog: { kind: 'command-failed', cause: 'exit 1' },
      });
      const context = await halt(await staleProject('seat-swap-fresh-empty-unread'), runner);

      expect(context?.routeAuth).toEqual({ kind: 'unknown', reason: 'catalog-not-read' });
    });

    it('probes nothing for a seat that names no model', async () => {
      const context = await halt(await staleProject('seat-swap-fresh-no-model'), {
        kind: 'cli',
        tool: 'opencode',
      });

      expect(evidence.detectRunnerEvidence).not.toHaveBeenCalled();
      expect(context?.routeAuth).toEqual({ kind: 'unchecked' });
    });
  });

  it("leads with the seat's declared fallback when the pass saw its tool ready", async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-fallback-ready', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      config: makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'codex',
          fallback: { tool: 'claude-code', model: 'sonnet', effort: 'high' },
        },
      }),
      runner: {
        kind: 'cli',
        tool: 'codex',
        fallback: { tool: 'claude-code', model: 'sonnet', effort: 'high' },
      },
    });

    expect(context?.fallbackBlockedReason).toBeUndefined();
    expect(context?.detectedTools[0]).toEqual({
      tool: 'claude-code',
      model: 'sonnet',
      effort: 'high',
      ready: true,
    });
    expect(switchSeatOffer(context)).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet', effort: 'high' }],
    });
  });

  it('offers an unverified fallback and never duplicates its bare detection', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-fallback-unverified', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unverified', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code', model: 'sonnet' } },
      config: makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'codex',
          fallback: { tool: 'claude-code', model: 'sonnet' },
        },
      }),
    });

    expect(context?.detectedTools.filter((tool) => tool.tool === 'claude-code')).toEqual([
      { tool: 'claude-code', model: 'sonnet', ready: true },
    ]);
  });

  it('names why a declared fallback is not offered', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-fallback-blocked', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unauthenticated', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      }),
    });

    expect(context?.fallbackBlockedReason).toBe('unauthenticated');
    expect(context?.detectedTools).toContainEqual({ tool: 'claude-code', ready: false });
    expect(switchSeatOffer(context)).toBeUndefined();
  });

  it.each([
    ['takes', ['ollama/llama3'], undefined],
    ['names why it does not take', ['lmstudio/qwen3'], 'unauthenticated'],
  ])(
    'reads a fallback tool that stores no credential against its saved model list: %s it',
    async (_case, models, blocked) => {
      const projectDir = createTempDir('seat-swap-fallback-no-credential');
      dirs.push(projectDir);
      mkdirSync(getSplitbriefPath(projectDir), { recursive: true });
      await saveDetectionCache({
        projectDir,
        snapshot: {
          contextKey: 'readiness-remembered',
          fetchedAt: Date.now(),
          validatedAt: Date.now(),
          generation: 1,
          requestId: 1,
          providers: [],
          cliTools: [
            cliDetectionFor('ready', 'codex'),
            cliDetectionFor('unauthenticated', 'opencode', { providerAuth: { kind: 'empty' } }),
          ],
          cliCatalogs: [
            { tool: 'opencode', models: models.map((id) => ({ id })), probedAt: Date.now() },
          ],
        },
      });
      const fallback = { tool: 'opencode', model: 'ollama/llama3' };

      const context = await loadSeatSwapContext({
        modelCache: undefined,
        projectDir,
        seat: 'build',
        runner: { kind: 'cli', tool: 'codex', fallback },
        config: makeConfig({ implementer: { kind: 'cli', tool: 'codex', fallback } }),
      });

      expect(context?.fallbackBlockedReason).toBe(blocked);
      expect(switchSeatOffer(context)?.candidates).toEqual(
        blocked === undefined ? [fallback] : undefined,
      );
    },
  );

  it('calls a declared fallback with no executable not installed', async () => {
    const projectDir = await projectWithRememberedTools('seat-swap-fallback-absent', [
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unavailable', 'claude-code'),
    ]);

    const context = await loadSeatSwapContext({
      modelCache: undefined,
      projectDir,
      seat: 'build',
      runner: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
      }),
    });

    expect(context?.fallbackBlockedReason).toBe('not installed');
  });
});

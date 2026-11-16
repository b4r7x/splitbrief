import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeExecutable } from '#testing/helpers/cli-executable.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection/tool.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection/executable.js';
import { detectAll, detectAvailableCliReadiness, detectAvailableCliTools } from './detect.js';
import { detectRunnerEvidence } from './runner-evidence/detect.js';

const executable: CliExecutableIdentity = {
  path: '/trusted/bin/tool',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
};

function apiContext(source: 'env' | 'inline'): RunnerDiscoveryContext {
  return {
    role: 'planner',
    kind: 'api',
    id: 'openai',
    authChannel: 'api-key',
    endpointOrigin: 'https://api.openai.example',
    credentialPresent: true,
    credentialDomain: {
      providerId: 'openai',
      endpointOrigin: 'https://api.openai.example',
      authChannel: 'api-key',
      credentialSource:
        source === 'env'
          ? { kind: 'env', name: 'CUSTOM_OPENAI_TOKEN' }
          : { kind: 'inline', configNodeId: 'opaque-config-node' },
      configGeneration: 'test-config-generation',
    },
    configGeneration: 'test-config-generation',
  };
}

describe('legacy CLI detection presentation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('retains unavailable and untrusted resolver facts separately', async () => {
    await withTempDir('detect-resolver-facts', async (projectDir) => {
      const projectBin = join(projectDir, 'bin');
      mkdirSync(projectBin);
      vi.stubEnv('PATH', projectBin);
      vi.useFakeTimers({ toFake: ['Date'], now: 7 });
      const unavailable = await detectAvailableCliTools({ tools: ['codex'], projectDir });
      makeExecutable(join(projectBin, 'codex'));
      vi.setSystemTime(8);
      const untrusted = await detectAvailableCliReadiness({ tools: ['codex'], projectDir });

      expect(unavailable).toMatchObject([
        {
          tool: 'codex',
          trust: 'not-checked',
          diagnostic: {
            state: 'unavailable',
            remediation: 'Install OpenAI Codex CLI, then ctrl+r.',
          },
          probedAt: 7,
        },
      ]);
      expect(untrusted).toMatchObject([
        {
          tool: 'codex',
          installation: 'installed',
          trust: 'untrusted',
          status: 'untrusted',
          remediation:
            'Install OpenAI Codex CLI outside the project. Put its absolute directory first on PATH, then run `splitbrief doctor` again.',
          probedAt: 8,
        },
      ]);
    });
  });
});

describe('context-bound runner evidence', () => {
  it('uses sanitized API credential identities only to report credential presence', async () => {
    const inline = await detectRunnerEvidence({ context: apiContext('inline'), now: () => 104 });
    const env = await detectRunnerEvidence({ context: apiContext('env'), now: () => 104 });

    expect(inline).toMatchObject({
      credential: 'present',
      auth: 'unknown',
      endpoint: { kind: 'not-run' },
      catalog: { kind: 'not-run' },
    });
    expect(env).toMatchObject({
      credential: 'present',
      auth: 'unknown',
      endpoint: { kind: 'not-run' },
      catalog: { kind: 'not-run' },
    });
    expect(inline.context.key).not.toBe(env.context.key);
  });
});

describe('detectAll', () => {
  it('returns only canonical provider and role-neutral CLI collections', async () => {
    const providers: ProviderDetection[] = [{ provider: 'ollama', available: true, isLocal: true }];
    const cliTools: CliToolDetection[] = [
      {
        tool: 'codex',
        executable,
        trust: 'trusted',
        installedVersion: '0.40.0',
        testedVersion: '0.40.0',
        compatibility: 'compatible',
        auth: 'unknown',
        diagnostic: {
          state: 'unverified',
          remediation: 'Authenticate and verify the CLI before selecting it.',
        },
        probedAt: 1,
      },
    ];

    const result = await detectAll({
      detectProviders: async () => providers,
      detectCliTools: async () => cliTools,
    });

    expect(result).toEqual({ providers, cliTools });
  });

  it('uses configured provider outcomes without constructing the legacy all-provider scan', async () => {
    const configuredProviderOutcomes = [
      {
        connection: {
          role: 'planner' as const,
          provider: 'ollama' as const,
          contextKey: 'planner',
        },
        outcome: {
          kind: 'success' as const,
          source: 'provider-runtime' as const,
          provider: 'ollama' as const,
          isLocal: true,
          credential: 'present' as const,
          catalog: 'empty' as const,
          models: [],
        },
      },
    ];

    const result = await detectAll({
      detectProviders: async () => {
        throw new Error('legacy provider scan must not be called');
      },
      detectConfiguredProviderOutcomes: async () => configuredProviderOutcomes,
      detectCliTools: async () => [],
    });

    expect(result).toEqual({ providers: [], cliTools: [], configuredProviderOutcomes });
  });
});

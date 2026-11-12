import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env, platform } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expireDeadlineAfterFile, freezeProbeDeadlines } from '#testing/helpers/fake-timers.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { stubSignInHome } from '#testing/helpers/sign-in-home.js';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import type {
  CliAuthState,
  CliExecutableIdentity,
  CliToolDetection,
  ProviderDetection,
} from '../../core/discovery/detection.js';
import type { AuthFact } from '../../core/discovery/runner-evidence.js';
import {
  CLI_TOOL_CATALOG,
  LISTED_CLI_TOOL_IDS,
  type CliAuthChannelId,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import { deriveCliReadiness } from '../../core/schemas/readiness.js';
import { error } from '../../utils/error.js';
import {
  isDeclaredCliProbeContract,
  type CliProbeContract,
} from '../runners/cli-tools/contract.js';
import { lookupCliReadinessProbe } from '../runners/cli-tools/registry.js';
import type { CliReadinessProbeEvidence } from '../runners/cli-tools/cli-probe-evidence.js';
import type { ProbeCliReadinessOptions } from '../runners/cli-tools/readiness-probe.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { detectAll, detectAvailableCliReadiness, detectAvailableCliTools } from './detect.js';
import { detectRunnerEvidence } from './runner-evidence.js';
import * as readinessProbeModule from '../runners/cli-tools/readiness-probe.js';

const executable: CliExecutableIdentity = {
  path: '/trusted/bin/tool',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
};

function cliContext(
  input: Readonly<{
    authChannel?: CliAuthChannelId | undefined;
    credentialPresent?: boolean | undefined;
    model?: string | undefined;
    role?: 'planner' | 'implementer' | undefined;
  }> = {},
): RunnerDiscoveryContext {
  return {
    role: input.role ?? 'planner',
    kind: 'cli',
    id: 'codex',
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.authChannel === undefined ? {} : { authChannel: input.authChannel }),
    credentialPresent: input.credentialPresent ?? false,
    configGeneration: 'test-config-generation',
  };
}

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

function readinessEvidence(auth: AuthFact): CliReadinessProbeEvidence {
  return {
    version: { kind: 'success', value: CLI_TOOL_CATALOG.codex.compatibility.testedVersion },
    auth,
  };
}

function declaredCatalogProbe(): CliProbeContract {
  const version = {
    command: ['codex', '--version'] as const,
    cwd: 'neutral' as const,
    maxOutputBytes: 1_024,
  };
  const auth = {
    command: ['codex', 'login', 'status'] as const,
    cwd: 'neutral' as const,
    maxOutputBytes: 1_024,
  };
  const catalog = {
    command: ['codex', 'models', 'list'] as const,
    cwd: 'neutral' as const,
    maxOutputBytes: 1_024,
  };
  return {
    version,
    declared: {
      kind: 'declared',
      version: {
        ...version,
        kind: 'version',
        parse: () => ({
          kind: 'success',
          value: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
        }),
      },
      auth: { ...auth, kind: 'auth-status', parse: () => 'verified' },
      catalog: {
        ...catalog,
        kind: 'catalog',
        parse: () => ({ kind: 'success', value: [] }),
      },
    },
  };
}

function legacyVersionOnlyProbe(): CliProbeContract {
  return {
    version: {
      command: ['codex', '--version'],
      cwd: 'neutral',
      maxOutputBytes: 1_024,
    },
  };
}

async function installCodexShim(directory: string, script: string): Promise<CliExecutableIdentity> {
  const shim = join(directory, 'codex');
  await writeFile(shim, script);
  await chmod(shim, 0o755);
  return resolveCliExecutable({ command: shim, projectDir: '/neutral/project' });
}

function catalogShim(marker: string, argvLog?: string): string {
  return [
    '#!/bin/sh',
    ...(argvLog === undefined ? [] : [`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`]),
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' 'codex-cli ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ -z "$3" ]; then',
    // Each listing names whether the sign-in of the session channel reached its staged HOME.
    `  if [ -f "$HOME/.codex/auth.json" ]; then sign_in=staged; else sign_in=absent; fi`,
    `  printf '%s\\n' "$sign_in" >> ${JSON.stringify(marker)}`,
    `  printf '%s\\n' ${JSON.stringify(JSON.stringify({ models: [{ id: 'model-a' }] }))}`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

function failingVersionCatalogShim(
  input: Readonly<{
    argvLog: string;
    catalogCredentialMarker: string;
    catalogMarker: string;
    credentialLog: string;
  }>,
): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(input.argvLog)}`,
    `printf '%s\\n' "\${OPENAI_API_KEY-unset}" >> ${JSON.stringify(input.credentialLog)}`,
    'if [ "$1" = "--version" ]; then',
    '  exit 77',
    'fi',
    'if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ -z "$3" ]; then',
    `  printf '%s\\n' ran > ${JSON.stringify(input.catalogMarker)}`,
    `  printf '%s\\n' "\${OPENAI_API_KEY-unset}" > ${JSON.stringify(input.catalogCredentialMarker)}`,
    `  printf '%s\\n' ${JSON.stringify(JSON.stringify({ models: [{ id: 'must-not-run' }] }))}`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

/**
 * A `codex` that logs each argv and answers `login status` like the tool: signed in when its
 * staged HOME holds the sign-in file or its environment holds `OPENAI_API_KEY`. Like the tool, it
 * keeps its own state beside the sign-in file, under `$HOME/.codex`.
 */
function signInCodexShim(
  input: Readonly<{ argvLog: string; versionLines: readonly string[] }>,
): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(input.argvLog)}`,
    'mkdir -p "$HOME/.codex/log" && printf "%s\\n" "$*" >> "$HOME/.codex/log/codex.log"',
    'if [ "$1" = "--version" ]; then',
    ...input.versionLines.map((line) => `  ${line}`),
    'fi',
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
    '  if [ -n "$OPENAI_API_KEY" ] || [ -f "$HOME/.codex/auth.json" ]; then',
    "    printf '%s\\n' 'Logged in'",
    '    exit 0',
    '  fi',
    "  printf '%s\\n' 'Not logged in' >&2",
    '  exit 1',
    'fi',
    'if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ -z "$3" ]; then',
    `  printf '%s\\n' ${JSON.stringify(JSON.stringify({ models: [{ id: 'model-a' }] }))}`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

const CODEX_VERSION_LINES = [
  `printf '%s\\n' 'codex-cli ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'`,
  'exit 0',
] as const;

function sequenceClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

freezeProbeDeadlines();

describe('legacy CLI detection presentation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['detectAvailableCliTools', detectAvailableCliTools],
    ['detectAvailableCliReadiness', detectAvailableCliReadiness],
  ] as const)('%s probes each listed CLI and reports the probe auth', async (_name, detect) => {
    const probed = new Set<CliToolId>();
    const results: readonly Readonly<{ auth: CliAuthState }>[] = await detect({
      projectDir: '/neutral/project',
      resolveExecutable: async () => executable,
      probeReadiness: async (options) => {
        probed.add(options.tool);
        return deriveProbe(options, 'authenticated');
      },
      now: () => 1_700_000_000_000,
    });

    expect(probed).toEqual(new Set(LISTED_CLI_TOOL_IDS));
    expect(results.map((result) => result.auth)).toEqual(
      LISTED_CLI_TOOL_IDS.map(() => 'authenticated'),
    );
  });

  it('keeps an unreadable credential oracle listing of a tool probed on its catalog channel', async () => {
    const [result] = await detectAvailableCliTools({
      tools: ['opencode'],
      resolveExecutable: async () => executable,
      probeReadiness: async (options) => ({
        ...deriveProbe(options),
        providerAuth: { kind: 'unreadable', reason: 'not-probed' },
      }),
      now: () => 10,
    });

    expect(result).toMatchObject({
      tool: 'opencode',
      providerAuth: { kind: 'unreadable', reason: 'not-probed' },
    });
  });

  it.runIf(platform !== 'win32')(
    'codex positive login status is ready and authenticated',
    async () => {
      await withTempDir('detect-codex-positive-login', async (directory) => {
        const shim = await installCodexShim(
          directory,
          [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then',
            "  printf '%s\\n' 'codex-cli 0.150.1'",
            '  exit 0',
            'fi',
            'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
            "  printf '%s\\n' 'Logged in using ChatGPT'",
            '  exit 0',
            'fi',
            'exit 1',
            '',
          ].join('\n'),
        );
        await mkdir(join(directory, '.codex'));
        await writeFile(join(directory, '.codex', 'auth.json'), '{}');
        vi.stubEnv('HOME', directory);
        vi.stubEnv('CODEX_HOME', join(directory, '.codex'));
        const [result] = await detectAvailableCliTools({
          tools: ['codex'],
          projectDir: directory,
          resolveExecutable: async () => shim,
          now: () => 43,
        });

        expect(result).toMatchObject({
          tool: 'codex',
          auth: 'authenticated',
          diagnostic: { state: 'ready', remediation: null },
          installedVersion: '0.150.1',
        });
      });
    },
    20_000,
  );

  it.each([
    ['stores no credential', 'unauthenticated', 'ollama/llama3'],
    ['is signed in', 'authenticated', undefined],
  ] as const)(
    'carries the model an OpenCode that %s selects in its own config only when its route decides the seat',
    async (_case, auth, selectedModel) => {
      await withTempDir('detect-selected-model', async (configHome) => {
        await mkdir(join(configHome, 'opencode'));
        await writeFile(join(configHome, 'opencode', 'opencode.json'), '{"model":"ollama/llama3"}');
        vi.stubEnv('XDG_CONFIG_HOME', configHome);
        const [result] = await detectAvailableCliTools({
          tools: ['opencode'],
          resolveExecutable: async () => executable,
          probeReadiness: async (options) => ({
            ...deriveProbe(options, auth),
            providerAuth: { kind: 'empty' },
          }),
          now: () => 11,
        });

        expect(result?.diagnostic.state).toBe(
          auth === 'authenticated' ? 'ready' : 'unauthenticated',
        );
        expect(result?.selectedModel).toBe(selectedModel);
      });
    },
  );

  it('retains unavailable and untrusted resolver facts separately', async () => {
    const unavailable = await detectAvailableCliTools({
      tools: ['codex'],
      resolveExecutable: async () => {
        throw error('cli-executable-unavailable', 'not installed');
      },
      now: () => 7,
    });
    const untrusted = await detectAvailableCliReadiness({
      tools: ['codex'],
      resolveExecutable: async () => {
        throw error('cli-executable-untrusted', 'project-local shadow');
      },
      now: () => 8,
    });

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

describe('context-bound runner evidence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(platform !== 'win32')(
    'dispatches no catalog command from the contextless readiness path',
    async () => {
      await withTempDir('detect-contextless-catalog', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shim = await installCodexShim(directory, catalogShim(marker));
        vi.stubEnv('HOME', directory);
        vi.stubEnv('CODEX_HOME', join(directory, '.codex'));

        try {
          const [readiness] = await detectAvailableCliReadiness({
            tools: ['codex'],
            projectDir: directory,
            resolveExecutable: async () => shim,
            now: () => 98,
          });

          expect(readiness).toMatchObject({
            tool: 'codex',
            installation: 'installed',
            installedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
          });
          expect(existsSync(marker)).toBe(false);
        } finally {
          vi.unstubAllEnvs();
        }
      });
    },
    20_000,
  );

  it('does not promote a metadata-only resolver result to a trusted executable fact', async () => {
    const evidence = await detectRunnerEvidence({
      context: cliContext({ authChannel: 'session' }),
      resolveExecutable: async () => executable,
      probeDeclaredReadiness: async () => readinessEvidence('verified'),
      now: () => 99,
    });

    expect(evidence.executable).toEqual({ kind: 'unknown' });
  });

  it.each([
    ['the inclusive Codex minimum', '0.40.0', 'compatible'],
    ['an admitted Codex patch', '0.40.7', 'compatible'],
    ['a newer Codex minor than the tested release', '0.41.0', 'compatible'],
    ['a current Codex release far above the tested minimum', '0.146.0', 'compatible'],
    ['a lower Codex release', '0.39.9', 'incompatible'],
    ['an earlier pre-1.0 Codex minor', '0.1.0', 'incompatible'],
    ['a Codex prerelease', '0.40.0-rc.1', 'unknown'],
    ['a malformed Codex version', '0.40', 'unknown'],
  ] as const)(
    "classifies %s through Codex's minimum admitted version",
    async (_label, version, kind) => {
      const evidence = await detectRunnerEvidence({
        context: cliContext({ authChannel: 'session' }),
        resolveExecutable: async () => executable,
        probeDeclaredReadiness: async () => ({
          version: { kind: 'success', value: version },
          auth: 'verified',
        }),
        now: () => 102,
      });

      expect(evidence.compatibility).toMatchObject({
        kind,
        installedVersion: version,
        testedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
      });
    },
  );

  it.each([
    ['missing', 'absent'],
    ['invalid', 'present'],
    ['policy-denied', 'unknown'],
    ['offline', 'unknown'],
    ['timeout', 'unknown'],
    ['malformed', 'unknown'],
  ] as const)('preserves the %s authentication fact', async (auth, credential) => {
    const evidence = await detectRunnerEvidence({
      context: cliContext({ authChannel: 'session' }),
      resolveExecutable: async () => executable,
      probeDeclaredReadiness: async () => readinessEvidence(auth),
      now: () => 102,
    });

    expect(evidence.auth).toBe(auth);
    expect(evidence.credential).toBe(credential);
  });

  it.runIf(platform !== 'win32')(
    'publishes catalog evidence only through the context-bound detector',
    async () => {
      await withTempDir('detect-context-catalog', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shim = await installCodexShim(directory, catalogShim(marker));
        await stubSignInHome(join(directory, 'home'), ['codex']);
        const options = {
          context: cliContext({ model: 'model-a' }),
          resolveExecutable: async () => shim,
          now: () => 103,
        };
        const omitted = await detectRunnerEvidence(options);
        const selected = await detectRunnerEvidence({ ...options, includeCatalog: true });

        expect(omitted.catalog).toEqual({ kind: 'not-run' });
        expect(selected.catalog).toEqual({
          kind: 'success',
          value: [{ id: 'model-a', nativeOrder: 0 }],
        });
        expect(selected.modelRun.kind).toBe('listed-unverified');
        expect(existsSync(marker)).toBe(true);
      });
    },
  );

  it.runIf(platform !== 'win32').each([
    ['names no channel', undefined],
    ['names a channel that codex does not have', 'provider-dependent'],
  ] as const)(
    'lists the codex catalog with the sign-in of its catalog channel when the context %s',
    async (_label, authChannel) => {
      await withTempDir('detect-catalog-channel', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shim = await installCodexShim(directory, catalogShim(marker));
        await stubSignInHome(join(directory, 'home'), ['codex']);

        const evidence = await detectRunnerEvidence({
          context: cliContext({ authChannel }),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 105,
        });

        expect(evidence.catalog).toEqual({
          kind: 'success',
          value: [{ id: 'model-a', nativeOrder: 0 }],
        });
        expect(readFileSync(marker, 'utf8')).toBe('staged\n');
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'lists no catalog for a codex that is signed out on its catalog channel',
    async () => {
      await withTempDir('detect-catalog-signed-out', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shim = await installCodexShim(directory, catalogShim(marker));
        await stubSignInHome(join(directory, 'home'), []);

        const evidence = await detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 106,
        });

        expect(evidence.catalog).toEqual({ kind: 'missing-credential' });
        expect(existsSync(marker)).toBe(false);
      });
    },
  );

  it.runIf(platform !== 'win32').each([
    ['reads its version', CODEX_VERSION_LINES],
    ['gives no version', ['exit 3']],
  ] as const)(
    'keeps a signed-out codex signed out despite a shell OPENAI_API_KEY when it %s',
    async (_label, versionLines) => {
      await withTempDir('detect-signed-out-shell-key', async (directory) => {
        const argvLog = join(directory, 'argv.log');
        const shim = await installCodexShim(directory, signInCodexShim({ argvLog, versionLines }));
        await stubSignInHome(join(directory, 'home'), []);
        vi.stubEnv('OPENAI_API_KEY', 'sk-shell-key-canary');

        const evidence = await detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 106,
        });

        expect(evidence.auth).toBe('missing');
        expect(evidence.catalog).toEqual({ kind: 'missing-credential' });
        expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual(['--version']);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'reports a catalog timeout for a signed-in codex whose version command never answers',
    async () => {
      await withTempDir('detect-signed-in-version-timeout', async (directory) => {
        const argvLog = join(directory, 'argv.log');
        const versionStarted = join(directory, 'version-started');
        const shim = await installCodexShim(
          directory,
          signInCodexShim({
            argvLog,
            versionLines: [`: > ${JSON.stringify(versionStarted)}`, 'exec tail -f /dev/null'],
          }),
        );
        await stubSignInHome(join(directory, 'home'), ['codex']);

        const pending = detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 106,
        });
        await expireDeadlineAfterFile(versionStarted);
        const evidence = await pending;

        expect(evidence.auth).toBe('verified');
        expect(evidence.catalog).toEqual({ kind: 'timeout' });
        expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
          '--version',
          'login status',
        ]);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'leaves the host codex sign-in file and the host HOME entries unchanged across the probes',
    async () => {
      await withTempDir('detect-host-home-unchanged', async (directory) => {
        const argvLog = join(directory, 'argv.log');
        const shim = await installCodexShim(
          directory,
          signInCodexShim({ argvLog, versionLines: CODEX_VERSION_LINES }),
        );
        const home = join(directory, 'home');
        await stubSignInHome(home, ['codex']);
        const signInFile = join(home, '.codex', 'auth.json');
        const signIn = readFileSync(signInFile, 'utf8');
        const hostEntries = readdirSync(home, { recursive: true }).sort();

        const evidence = await detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 106,
        });

        expect(evidence.auth).toBe('verified');
        expect(evidence.catalog.kind).toBe('success');
        expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
          '--version',
          'login status',
          'debug models',
        ]);
        expect(readFileSync(signInFile, 'utf8')).toBe(signIn);
        expect(readdirSync(home, { recursive: true }).sort()).toEqual(hostEntries);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'keeps catalog work scoped to an exact complete context',
    async () => {
      await withTempDir('detect-context-scope', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shim = await installCodexShim(directory, catalogShim(marker));
        await stubSignInHome(join(directory, 'home'), ['codex']);
        const exact = {
          ...cliContext({ model: 'model-a' }),
          configGeneration: 'context-generation-a',
        };
        const changedGeneration = {
          ...exact,
          configGeneration: 'context-generation-b',
        };
        const first = await detectRunnerEvidence({
          context: exact,
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 104,
        });
        const second = await detectRunnerEvidence({
          context: changedGeneration,
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 104,
        });

        expect(first.catalog.kind).toBe('success');
        expect(second.catalog.kind).toBe('success');
        expect(first.context.key).not.toBe(second.context.key);
        expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2);

        const sourceDomain = {
          providerId: 'openai',
          endpointOrigin: 'https://api.openai.example',
          authChannel: 'api-key' as const,
          credentialSource: { kind: 'env' as const, name: 'CONTEXT_SCOPE_KEY' },
          configGeneration: exact.configGeneration,
        };
        const invalidContexts: readonly RunnerDiscoveryContext[] = [
          { ...exact, configGeneration: '' },
          { ...exact, credentialPresent: true, credentialDomain: sourceDomain },
          {
            ...exact,
            credentialPresent: true,
            credentialDomain: {
              ...sourceDomain,
              credentialSource: { kind: 'inline', configNodeId: 'other-source-node' },
            },
          },
        ];

        for (const context of invalidContexts) {
          const evidence = await detectRunnerEvidence({
            context,
            resolveExecutable: async () => shim,
            includeCatalog: true,
            now: () => 104,
          });
          expect(evidence.catalog).toEqual({ kind: 'not-run' });
        }
        expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'ignores an injected declaration and preserves canonical version-to-catalog ordering',
    async () => {
      await withTempDir('detect-invented-declared-probe', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const argvLog = join(directory, 'argv.log');
        const shim = await installCodexShim(directory, catalogShim(marker, argvLog));
        await stubSignInHome(join(directory, 'home'), ['codex']);

        const evidence = await detectRunnerEvidence({
          context: cliContext({ model: 'model-a' }),
          resolveExecutable: async () => shim,
          lookupProbe: () => declaredCatalogProbe(),
          includeCatalog: true,
          now: () => 107,
        });

        expect(evidence.catalog).toEqual({
          kind: 'success',
          value: [{ id: 'model-a', nativeOrder: 0 }],
        });
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
          '--version',
          'login status',
          'debug models',
        ]);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'does not let injected readiness facts or callbacks authorize catalog work',
    async () => {
      type DeclaredReadinessSeam = typeof readinessProbeModule.probeDeclaredCliReadinessEvidence;
      const variants = [
        {
          label: 'compatible version and verified authentication',
          create:
            (seamMarker: string): DeclaredReadinessSeam =>
            async () => {
              await writeFile(seamMarker, 'called');
              return readinessEvidence('verified');
            },
        },
        {
          label: 'unsupported version and unsupported authentication',
          create:
            (seamMarker: string): DeclaredReadinessSeam =>
            async () => {
              await writeFile(seamMarker, 'called');
              return { version: { kind: 'unsupported' }, auth: 'not-run' };
            },
        },
        {
          label: 'malformed version and malformed authentication',
          create:
            (seamMarker: string): DeclaredReadinessSeam =>
            async () => {
              await writeFile(seamMarker, 'called');
              return { version: { kind: 'malformed' }, auth: 'malformed' };
            },
        },
        {
          label: 'a wrapper around the canonical readiness implementation',
          create:
            (seamMarker: string): DeclaredReadinessSeam =>
            async (options) => {
              await writeFile(seamMarker, 'called');
              const evidence =
                await readinessProbeModule.probeDeclaredCliReadinessEvidence(options);
              return { ...evidence, ...readinessEvidence('verified') };
            },
        },
      ] as const;

      for (const variant of variants) {
        await withTempDir(`detect-injected-readiness-${variant.label}`, async (directory) => {
          const argvLog = join(directory, 'argv.log');
          const catalogCredentialMarker = join(directory, 'catalog-credential');
          const catalogMarker = join(directory, 'catalog-ran');
          const credentialLog = join(directory, 'credential.log');
          const seamMarker = join(directory, 'readiness-seam-called');
          const shim = await installCodexShim(
            directory,
            failingVersionCatalogShim({
              argvLog,
              catalogCredentialMarker,
              catalogMarker,
              credentialLog,
            }),
          );
          await stubSignInHome(join(directory, 'home'), ['codex']);
          const originalOpenAiApiKey = env.OPENAI_API_KEY;
          let observedMutation = true;
          env.OPENAI_API_KEY = 'r5-injected-secret';
          try {
            const evidence = await detectRunnerEvidence({
              context: cliContext(),
              resolveExecutable: async () => shim,
              lookupProbe: () => {
                throw error(
                  'cli-executable-unavailable',
                  'Injected lookup must never authorize catalog work.',
                );
              },
              probeDeclaredReadiness: variant.create(seamMarker),
              includeCatalog: true,
              onResolvedCliExecutable: (resolved) => {
                observedMutation = Reflect.set(resolved, 'path', '/injected/catalog-path');
              },
              now: () => 108,
            });

            expect(evidence.catalog).toEqual({ kind: 'not-run' });
            expect(evidence.compatibility).toMatchObject({
              kind: 'unknown',
              installedVersion: null,
            });
            expect(observedMutation).toBe(false);
            expect(existsSync(seamMarker)).toBe(false);
            expect(existsSync(catalogMarker)).toBe(false);
            expect(existsSync(catalogCredentialMarker)).toBe(false);
            expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
              '--version',
              'login status',
            ]);
            expect(readFileSync(credentialLog, 'utf8').trim().split('\n')).toEqual([
              'unset',
              'unset',
            ]);
          } finally {
            if (originalOpenAiApiKey === undefined) {
              Reflect.deleteProperty(env, 'OPENAI_API_KEY');
            } else {
              env.OPENAI_API_KEY = originalOpenAiApiKey;
            }
          }
        });
      }
    },
  );

  it.runIf(platform !== 'win32')(
    'leaves a provider-listing tool out of the sign-in rule when the version probe times out',
    async () => {
      await withTempDir('detect-oracle-version-timeout', async (directory) => {
        const versionStarted = join(directory, 'version-started');
        const script = join(directory, 'opencode');
        await writeFile(
          script,
          [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then',
            `  : > ${JSON.stringify(versionStarted)}`,
            '  exec tail -f /dev/null',
            'fi',
            'exit 1',
            '',
          ].join('\n'),
        );
        await chmod(script, 0o755);
        const shim = await resolveCliExecutable({
          command: script,
          projectDir: '/neutral/project',
        });

        const home = join(directory, 'home');
        vi.stubEnv('HOME', home);
        vi.stubEnv('XDG_DATA_HOME', home);
        vi.stubEnv('XDG_CONFIG_HOME', home);
        try {
          const pending = detectRunnerEvidence({
            context: {
              role: 'planner',
              kind: 'cli',
              id: 'opencode',
              authChannel: 'provider-dependent',
              credentialPresent: false,
              configGeneration: 'test-config-generation',
            },
            resolveExecutable: async () => shim,
            includeCatalog: true,
            projectDir: '/neutral/project',
          });
          await expireDeadlineAfterFile(versionStarted);
          const evidence = await pending;

          expect(evidence.auth).toBe('missing');
          expect(evidence.catalog).toEqual({ kind: 'timeout' });
        } finally {
          vi.unstubAllEnvs();
        }
      });
    },
    20_000,
  );

  it.runIf(platform !== 'win32')(
    'uses the exact 30-second catalog admission boundary and rejects older or future clocks',
    async () => {
      const cases = [
        {
          label: 'exactly 30,000 milliseconds',
          clock: [0, 1_000, 31_000],
          expected: 'success',
          spawned: true,
        },
        {
          label: '30,001 milliseconds',
          clock: [0, 1_000, 31_001],
          expected: 'unsupported',
          spawned: false,
        },
        {
          label: 'a future-issued operation',
          clock: [0, 1_000, 999],
          expected: 'unsupported',
          spawned: false,
        },
      ] as const;

      for (const testCase of cases) {
        await withTempDir(`detect-catalog-clock-${testCase.label}`, async (directory) => {
          const marker = join(directory, 'catalog-ran');
          const shim = await installCodexShim(directory, catalogShim(marker));
          await stubSignInHome(join(directory, 'home'), ['codex']);

          const evidence = await detectRunnerEvidence({
            context: cliContext(),
            resolveExecutable: async () => shim,
            includeCatalog: true,
            now: sequenceClock(testCase.clock),
          });

          expect(evidence.catalog.kind).toBe(testCase.expected);
          expect(existsSync(marker)).toBe(testCase.spawned);
        });
      }
    },
  );

  it.runIf(platform !== 'win32')(
    'keeps the admitted catalog argv, parser, limits, and shape immutable after issuance',
    async () => {
      await withTempDir('detect-catalog-immutable-operation', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shim = await installCodexShim(directory, catalogShim(marker));
        await stubSignInHome(join(directory, 'home'), ['codex']);
        const probe = lookupCliReadinessProbe({ tool: 'codex', role: 'planner' });
        expect(isDeclaredCliProbeContract(probe)).toBe(true);
        if (!isDeclaredCliProbeContract(probe)) return;

        const { declared } = probe;
        if (declared.catalog.kind === 'not-run') return;
        const catalog = declared.catalog;
        let calls = 0;
        let mutationResults: readonly boolean[] = [];
        const now = () => {
          calls += 1;
          if (calls === 1) return 0;
          if (calls === 2) return 1_000;
          // The operation was admitted from its private copy immediately
          // before this freshness check; public registry mutation is too late.
          mutationResults = [
            Reflect.set(catalog.command, 0, 'attacker'),
            Reflect.set(catalog, 'parse', () => ({ kind: 'success', value: [] })),
            Reflect.set(declared, 'catalog', { kind: 'not-run' }),
          ];
          return 1_001;
        };

        const evidence = await detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now,
        });

        expect(mutationResults).toEqual([false, false, false]);
        expect(evidence.catalog).toEqual({
          kind: 'success',
          value: [{ id: 'model-a', nativeOrder: 0 }],
        });
        expect(existsSync(marker)).toBe(true);
      });
    },
  );

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

  it.runIf(platform !== 'win32')(
    'uses the admitted parser contract and never retains raw probe output',
    async () => {
      await withTempDir('detect-runner-evidence', async (directory) => {
        const rawProbeText = 'raw-probe-output-must-not-escape';
        const shim = await installCodexShim(
          directory,
          [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then',
            `  printf '%s\\n' 'codex-cli ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'`,
            '  exit 0',
            'fi',
            'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
            `  printf '%s\\n' 'Logged in ${rawProbeText}'`,
            '  exit 0',
            'fi',
            'exit 1',
            '',
          ].join('\n'),
        );
        await mkdir(join(directory, '.codex'));
        await writeFile(join(directory, '.codex', 'auth.json'), '{}');
        vi.stubEnv('HOME', directory);
        vi.stubEnv('CODEX_HOME', join(directory, '.codex'));
        try {
          const evidence = await detectRunnerEvidence({
            context: cliContext({ authChannel: 'session', credentialPresent: true }),
            projectDir: directory,
            resolveExecutable: async () => shim,
            now: () => 105,
          });

          expect(evidence).toMatchObject({
            installation: 'installed',
            executable: { kind: 'trusted' },
            compatibility: {
              kind: 'compatible',
              installedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
            },
            auth: 'verified',
          });
          expect(JSON.stringify(evidence)).not.toContain(rawProbeText);
        } finally {
          vi.unstubAllEnvs();
        }
      });
    },
    20_000,
  );

  it.runIf(platform !== 'win32')(
    'keeps a version-only legacy shim authentication-unknown',
    async () => {
      await withTempDir('detect-version-only', async (directory) => {
        const unexpectedAuthMarker = join(directory, 'unexpected-auth-probe');
        const shim = await installCodexShim(
          directory,
          [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then',
            `  printf '%s\\n' 'codex ${CLI_TOOL_CATALOG.codex.compatibility.testedVersion}'`,
            '  exit 0',
            'fi',
            `touch '${unexpectedAuthMarker}'`,
            'exit 1',
            '',
          ].join('\n'),
        );
        const evidence = await detectRunnerEvidence({
          context: cliContext({ authChannel: 'session', credentialPresent: true }),
          projectDir: directory,
          resolveExecutable: async () => shim,
          lookupProbe: () => legacyVersionOnlyProbe(),
          now: () => 106,
        });

        expect(evidence).toMatchObject({
          compatibility: {
            kind: 'compatible',
            installedVersion: CLI_TOOL_CATALOG.codex.compatibility.testedVersion,
          },
          auth: 'unknown',
        });
        expect(existsSync(unexpectedAuthMarker)).toBe(false);
      });
    },
    20_000,
  );
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

function deriveProbe(options: ProbeCliReadinessOptions, auth: CliAuthState = 'not-checked') {
  const testedVersion = CLI_TOOL_CATALOG[options.tool].compatibility.testedVersion;
  const compatibility = options.classifyVersion?.({
    installedVersion: testedVersion,
    testedVersion,
  });
  return deriveCliReadiness({
    tool: options.tool,
    enabled: true,
    installation: 'installed',
    executable: options.executable,
    trust: 'trusted',
    installedVersion: testedVersion,
    testedVersion,
    compatibility: compatibility ?? 'unverified',
    auth,
    probedAt: options.now?.() ?? Date.now(),
  });
}

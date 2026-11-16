import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { env, platform } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeExecutable } from '#testing/helpers/cli-executable.js';
import { expireDeadlineAfterFile, freezeProbeDeadlines } from '#testing/helpers/fake-timers.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { stubSignInHome } from '#testing/helpers/sign-in-home.js';
import {
  CODEX_VERSION_LINES,
  installToolShim,
  signInCodexShim,
} from '#testing/helpers/tool-shim.js';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import type { CliAuthState, CliTrustState } from '../../core/discovery/detection/tool.js';
import type { CliAuthChannelId } from '../../core/runners/cli-tool/auth-channels.js';
import { CLI_TOOL_CATALOG, LISTED_CLI_TOOL_IDS } from '../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../core/runners/cli-tool/types.js';
import { resolveCliExecutable } from '../runners/cli-executable/resolve.js';
import { lookupCliReadinessProbe } from '../runners/cli-tools/registry.js';
import { detectAvailableCliReadiness, detectAvailableCliTools } from './detect.js';
import { detectRunnerEvidence } from './runner-evidence/detect.js';

/**
 * An `opencode` at its tested release whose credential listing prints `listing`, or exits 1 when
 * `listing` is undefined.
 */
function opencodeShim(listing: string | undefined): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' 'opencode ${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "auth" ] && [ "$2" = "list" ]; then',
    ...(listing === undefined
      ? ['  exit 1']
      : [`  printf '%b' ${JSON.stringify(listing)}`, '  exit 0']),
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

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

function sequenceClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

freezeProbeDeadlines();

describe('legacy CLI detection presentation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(platform !== 'win32').each([
    ['detectAvailableCliTools', detectAvailableCliTools],
    ['detectAvailableCliReadiness', detectAvailableCliReadiness],
  ] as const)(
    '%s looks up each listed CLI and reports the probe auth of the installed one',
    async (_name, detect) => {
      await withTempDir('detect-listed-probe-auth', async (directory) => {
        const argvLog = join(directory, 'argv.log');
        await installToolShim(
          directory,
          'codex',
          signInCodexShim({ argvLog, versionLines: CODEX_VERSION_LINES }),
        );
        await stubSignInHome(join(directory, 'home'), ['codex']);
        // A project-local file named as each other tool is found, so detection refuses it as untrusted.
        const projectDir = join(directory, 'project');
        const shadowDir = join(projectDir, 'bin');
        await mkdir(shadowDir, { recursive: true });
        for (const tool of LISTED_CLI_TOOL_IDS) {
          if (tool !== 'codex') makeExecutable(join(shadowDir, CLI_TOOL_CATALOG[tool].command));
        }
        vi.stubEnv('PATH', [directory, shadowDir].join(delimiter));

        const results: readonly Readonly<{
          tool: CliToolId;
          auth: CliAuthState;
          trust: CliTrustState;
        }>[] = await detect({ projectDir });

        expect(results.map(({ tool, auth, trust }) => ({ tool, auth, trust }))).toEqual(
          LISTED_CLI_TOOL_IDS.map((tool) =>
            tool === 'codex'
              ? { tool, auth: 'authenticated', trust: 'trusted' }
              : { tool, auth: 'not-checked', trust: 'untrusted' },
          ),
        );
        expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
          '--version',
          'login status',
        ]);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'keeps an unreadable credential oracle listing of a tool probed on its catalog channel',
    async () => {
      await withTempDir('detect-unreadable-listing', async (directory) => {
        await installToolShim(directory, 'opencode', opencodeShim(undefined));
        await stubSignInHome(join(directory, 'home'), []);
        vi.stubEnv('PATH', directory);

        const [result] = await detectAvailableCliTools({ tools: ['opencode'] });

        expect(result).toMatchObject({
          tool: 'opencode',
          providerAuth: { kind: 'unreadable', reason: 'exit-failure' },
        });
      });
    },
  );

  it.runIf(platform !== 'win32').each([
    ['stores no credential', 'Credentials\n0 credentials\n', 'unauthenticated', 'ollama/llama3'],
    ['is signed in', 'Credentials\nanthropic  oauth\n1 credential\n', 'ready', undefined],
  ] as const)(
    'carries the model an OpenCode that %s selects in its own config only when its route decides the seat',
    async (_case, listing, state, selectedModel) => {
      await withTempDir('detect-selected-model', async (directory) => {
        await installToolShim(directory, 'opencode', opencodeShim(listing));
        await stubSignInHome(join(directory, 'home'), []);
        const configHome = join(directory, 'config');
        await mkdir(join(configHome, 'opencode'), { recursive: true });
        await writeFile(join(configHome, 'opencode', 'opencode.json'), '{"model":"ollama/llama3"}');
        vi.stubEnv('XDG_CONFIG_HOME', configHome);
        vi.stubEnv('PATH', directory);
        const [result] = await detectAvailableCliTools({ tools: ['opencode'] });

        expect(result?.diagnostic.state).toBe(state);
        expect(result?.selectedModel).toBe(selectedModel);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'codex positive login status is ready and authenticated',
    async () => {
      await withTempDir('detect-codex-positive-login', async (directory) => {
        await installToolShim(
          directory,
          'codex',
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
        vi.stubEnv('PATH', directory);
        const [result] = await detectAvailableCliTools({
          tools: ['codex'],
          projectDir: join(directory, 'project'),
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
});

describe('context-bound runner evidence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(platform !== 'win32')(
    'does not promote a metadata-only resolver result to a trusted executable fact',
    async () => {
      await withTempDir('detect-metadata-only', async (directory) => {
        const argvLog = join(directory, 'argv.log');
        const { path, fingerprint } = await installToolShim(
          directory,
          'codex',
          signInCodexShim({ argvLog, versionLines: CODEX_VERSION_LINES }),
        );
        await stubSignInHome(join(directory, 'home'), ['codex']);

        const evidence = await detectRunnerEvidence({
          context: {
            role: 'planner',
            kind: 'cli',
            id: 'codex',
            authChannel: 'session',
            credentialPresent: false,
            configGeneration: 'test-config-generation',
          },
          resolveExecutable: async () => ({ path, fingerprint }),
          now: () => 99,
        });

        expect(evidence.auth).toBe('verified');
        expect(evidence.executable).toEqual({ kind: 'unknown' });
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'dispatches no catalog command from the contextless readiness path',
    async () => {
      await withTempDir('detect-contextless-catalog', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        await installToolShim(directory, 'codex', catalogShim(marker));
        vi.stubEnv('HOME', directory);
        vi.stubEnv('CODEX_HOME', join(directory, '.codex'));
        vi.stubEnv('PATH', directory);

        try {
          const [readiness] = await detectAvailableCliReadiness({
            tools: ['codex'],
            projectDir: join(directory, 'project'),
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

  it.runIf(platform !== 'win32')(
    'publishes catalog evidence only through the context-bound detector',
    async () => {
      await withTempDir('detect-context-catalog', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shim = await installToolShim(directory, 'codex', catalogShim(marker));
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
        const shim = await installToolShim(directory, 'codex', catalogShim(marker));
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
        const shim = await installToolShim(directory, 'codex', catalogShim(marker));
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
        const shim = await installToolShim(
          directory,
          'codex',
          signInCodexShim({ argvLog, versionLines }),
        );
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
        const shim = await installToolShim(
          directory,
          'codex',
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
        const shim = await installToolShim(
          directory,
          'codex',
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
        const shim = await installToolShim(directory, 'codex', catalogShim(marker));
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
    'does not let a callback or a failed version check authorize catalog work',
    async () => {
      await withTempDir('detect-failed-version-catalog', async (directory) => {
        const argvLog = join(directory, 'argv.log');
        const catalogCredentialMarker = join(directory, 'catalog-credential');
        const catalogMarker = join(directory, 'catalog-ran');
        const credentialLog = join(directory, 'credential.log');
        const shim = await installToolShim(
          directory,
          'codex',
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
          const shim = await installToolShim(directory, 'codex', catalogShim(marker));
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
        const shim = await installToolShim(directory, 'codex', catalogShim(marker));
        await stubSignInHome(join(directory, 'home'), ['codex']);
        const probe = lookupCliReadinessProbe({ tool: 'codex', role: 'planner' });
        if (probe.catalog.kind === 'not-run') return;
        const catalog = probe.catalog;
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
            Reflect.set(probe, 'catalog', { kind: 'not-run' }),
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

  it.runIf(platform !== 'win32')(
    'uses the admitted parser contract and never retains raw probe output',
    async () => {
      await withTempDir('detect-runner-evidence', async (directory) => {
        const rawProbeText = 'raw-probe-output-must-not-escape';
        const shim = await installToolShim(
          directory,
          'codex',
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
});

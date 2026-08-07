import http from 'node:http';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import { createProductionDetectionDeps } from './deps.js';
import { resolveDetectionSourceContexts } from './service.js';

function requestUrl(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  return typeof input === 'string' ? input : input.toString();
}

async function withLoopbackServer(
  run: (input: Readonly<{ apiBase: string; requests: http.IncomingMessage[] }>) => Promise<void>,
): Promise<void> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    if (request.url !== '/api/v1/models') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a loopback detection test server address.');
  }

  try {
    await run({ apiBase: `http://127.0.0.1:${address.port}/v1`, requests });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('createProductionDetectionDeps', () => {
  // detectAll runs real readiness probes; an empty PATH keeps these tests off
  // the developer machine's actual CLI binaries (oracle latency is unbounded).
  let realPath: string | undefined;
  let emptyPathDir: string;
  beforeEach(() => {
    realPath = process.env.PATH;
    emptyPathDir = createTempDir('production-deps-empty-path');
    process.env.PATH = emptyPathDir;
  });
  afterEach(() => {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    cleanupTempDir(emptyPathDir);
  });

  it('binds every discovery lane to the current project, endpoint, channel, and credential domain without storing credential bytes', () => {
    const configA = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'openai',
        apiBase: 'https://gateway-a.example.test/v1',
        apiKey: 'sk-private-config-a',
        model: 'gpt-5.4',
      },
    });
    const configB = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'openai',
        apiBase: 'https://gateway-b.example.test/v1',
        apiKey: 'sk-private-config-b',
        model: 'gpt-5.4',
      },
    });

    const contextsA = resolveDetectionSourceContexts({
      deps: createProductionDetectionDeps({ config: configA, projectDir: '/projects/a' }),
      projectDir: '/projects/a',
    });
    const contextsB = resolveDetectionSourceContexts({
      deps: createProductionDetectionDeps({ config: configB, projectDir: '/projects/b' }),
      projectDir: '/projects/b',
    });

    expect(contextsA.readiness).not.toBe(contextsB.readiness);
    expect(contextsA.modelsDev).not.toBe(contextsB.modelsDev);
    expect(contextsA.cliModels).not.toBe(contextsB.cliModels);
    expect(JSON.stringify(contextsA)).not.toContain('sk-private-config-a');
    expect(JSON.stringify(contextsB)).not.toContain('sk-private-config-b');
    // The salted readiness/cliModels lanes key pre-widening snapshots out.
    expect(contextsA.readiness).toContain(encodeURIComponent('readiness:all-tools:'));
    expect(contextsA.modelsDev).not.toContain('all-tools');
    expect(contextsA.cliModels).toContain(encodeURIComponent('cliModels:all-tools:'));
  });

  it('probes only the configured built-in API endpoint with its raw override held closure-local', async () => {
    await withLoopbackServer(async ({ apiBase, requests }) => {
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const fetchUrls: string[] = [];
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        fetchUrls.push(url);
        if (!url.startsWith(apiBase.replace(/\/v1$/, ''))) {
          return Promise.reject(new Error(`Unexpected unselected provider request: ${url}`));
        }
        return nativeFetch(input, init);
      });
      try {
        const config = makeConfig({
          planner: { kind: 'shell', command: 'printf planner' },
          implementer: {
            kind: 'api',
            provider: 'lm-studio',
            apiBase,
            apiKey: 'configured-lm-studio-key',
            model: 'local-model',
          },
        });

        const result = await createProductionDetectionDeps({
          config,
          projectDir: '/projects/configured-lm-studio',
        }).detectAll({ signal: new AbortController().signal });

        expect(fetchUrls).toEqual([`${apiBase.replace(/\/v1$/, '')}/api/v1/models`]);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers.authorization).toBe('Bearer configured-lm-studio-key');
        expect(result.providers).toEqual([]);
        expect(result.configuredProviderOutcomes).toEqual([
          expect.objectContaining({
            connection: expect.objectContaining({ role: 'implementer', provider: 'lm-studio' }),
            outcome: expect.objectContaining({ kind: 'success', catalog: 'empty', models: [] }),
          }),
        ]);
        expect(JSON.stringify(result)).not.toContain('configured-lm-studio-key');
        expect(JSON.stringify(result)).not.toContain(apiBase);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }, 20_000);

  it('does not construct or request a custom API provider string', async () => {
    const fetchUrls: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      fetchUrls.push(requestUrl(input));
      return Promise.reject(new Error('Custom providers must not be probed.'));
    });
    try {
      const config = makeConfig({
        planner: { kind: 'shell', command: 'printf planner' },
        implementer: {
          kind: 'api',
          provider: 'custom-private-provider',
          service: 'custom-private-provider',
          offering: 'payg',
          apiBase: 'https://custom-private-provider.example/v1',
          apiKey: 'custom-private-key',
          model: 'custom-model',
        },
      });

      const result = await createProductionDetectionDeps({
        config,
        projectDir: '/projects/custom-provider',
      }).detectAll({ signal: new AbortController().signal });

      expect(fetchUrls).toEqual([]);
      expect(result.configuredProviderOutcomes).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('custom-private-key');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);

  it('reuses an Anthropic API catalog for Agent SDK only when T003 credential-domain identity matches exactly', async () => {
    const originalShared = process.env.R5_SHARED_ANTHROPIC_KEY;
    const originalSdk = process.env.R5_SDK_ANTHROPIC_KEY;
    const originalApi = process.env.R5_API_ANTHROPIC_KEY;
    try {
      process.env.R5_SHARED_ANTHROPIC_KEY = 'sk-ant-shared-key';
      process.env.R5_SDK_ANTHROPIC_KEY = 'sk-ant-sdk-key';
      process.env.R5_API_ANTHROPIC_KEY = 'sk-ant-api-key';
      const calls: string[] = [];
      vi.stubGlobal('fetch', (input: string | URL | Request) => {
        calls.push(requestUrl(input));
        return Promise.resolve(
          new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 }),
        );
      });
      try {
        const exact = makeConfig({
          planner: {
            kind: 'agent-sdk',
            apiKey: 'env:R5_SHARED_ANTHROPIC_KEY',
            model: 'claude-sonnet-4-6',
          },
          implementer: {
            kind: 'api',
            provider: 'anthropic',
            apiBase: 'https://api.anthropic.com/v1',
            apiKey: 'env:R5_SHARED_ANTHROPIC_KEY',
            model: 'claude-sonnet-4-6',
          },
        });
        const exactResult = await createProductionDetectionDeps({
          config: exact,
          projectDir: '/projects/exact-sdk-domain',
        }).detectAll({ signal: new AbortController().signal });

        expect(calls.filter((url) => url.startsWith('https://api.anthropic.com/'))).toHaveLength(1);
        expect(
          exactResult.configuredProviderOutcomes?.map((entry) => entry.connection.role).toSorted(),
        ).toEqual(['implementer', 'planner']);

        calls.length = 0;
        const near = makeConfig({
          planner: {
            kind: 'agent-sdk',
            apiKey: 'env:R5_SDK_ANTHROPIC_KEY',
            model: 'claude-sonnet-4-6',
          },
          implementer: {
            kind: 'api',
            provider: 'anthropic',
            apiBase: 'https://api.anthropic.com/v1',
            apiKey: 'env:R5_API_ANTHROPIC_KEY',
            model: 'claude-sonnet-4-6',
          },
        });
        await createProductionDetectionDeps({
          config: near,
          projectDir: '/projects/near-sdk-domain',
        }).detectAll({ signal: new AbortController().signal });

        expect(calls.filter((url) => url.startsWith('https://api.anthropic.com/'))).toHaveLength(2);
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      if (originalShared === undefined) delete process.env.R5_SHARED_ANTHROPIC_KEY;
      else process.env.R5_SHARED_ANTHROPIC_KEY = originalShared;
      if (originalSdk === undefined) delete process.env.R5_SDK_ANTHROPIC_KEY;
      else process.env.R5_SDK_ANTHROPIC_KEY = originalSdk;
      if (originalApi === undefined) delete process.env.R5_API_ANTHROPIC_KEY;
      else process.env.R5_API_ANTHROPIC_KEY = originalApi;
    }
  }, 20_000);
});

const HOST_DETECTION_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

const SEEDED_SESSION_STATE_PATHS = [
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.config/opencode/auth.json',
  '.copilot/config.json',
  '.config/kilo/auth.json',
] as const;

const CLI_VERSION_LABELS: Record<CliToolId, string> = {
  'claude-code': 'claude ',
  codex: 'codex-cli ',
  opencode: '',
  aider: 'aider ',
  copilot: 'copilot version ',
  'kilo-code': '',
};

const CLI_AUTH_STATUS_RESPONSES: Partial<Record<CliToolId, readonly string[]>> = {
  'claude-code': [
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
    `  printf '%s\\n' '{"loggedIn": true}'`,
    '  exit 0',
    'fi',
  ],
  codex: [
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
    "  printf '%s\\n' 'Logged in using ChatGPT'",
    '  exit 0',
    'fi',
  ],
};

function cliShimScript(tool: CliToolId, argvLog: string | undefined): string {
  const version = `${CLI_VERSION_LABELS[tool]}${CLI_TOOL_CATALOG[tool].compatibility.testedVersion}`;
  return [
    '#!/bin/sh',
    ...(argvLog === undefined ? [] : [`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`]),
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' '${version}'`,
    '  exit 0',
    'fi',
    ...(CLI_AUTH_STATUS_RESPONSES[tool] ?? []),
    'exit 1',
    '',
  ].join('\n');
}

/**
 * Isolates PATH, HOME-family state roots, and credential env so detection can
 * only see the installed shims and the seeded session files — never this
 * machine's real logins, keychain, or auth files.
 */
async function withAdmittedCliHost(
  input: Readonly<{
    shims: readonly CliToolId[];
    sessionState: readonly string[];
    credentialEnv?: Readonly<Record<string, string>> | undefined;
    argvLogTool?: CliToolId | undefined;
    run: (host: Readonly<{ argvLog: string }>) => Promise<void>;
  }>,
): Promise<void> {
  const shimDir = createTempDir('admitted-cli-shims');
  const stateHome = createTempDir('admitted-cli-home');
  const argvLog = join(shimDir, 'argv.log');
  const saved = HOST_DETECTION_ENV.map((name) => [name, process.env[name]] as const);
  try {
    for (const tool of input.shims) {
      const shim = join(shimDir, CLI_TOOL_CATALOG[tool].command);
      writeFileSync(shim, cliShimScript(tool, input.argvLogTool === tool ? argvLog : undefined));
      chmodSync(shim, 0o755);
    }
    for (const relativePath of input.sessionState) {
      mkdirSync(join(stateHome, dirname(relativePath)), { recursive: true });
      writeFileSync(join(stateHome, relativePath), '{"session":"stub"}\n', 'utf8');
    }
    for (const name of HOST_DETECTION_ENV) delete process.env[name];
    process.env.PATH = shimDir;
    process.env.HOME = stateHome;
    for (const [name, value] of Object.entries(input.credentialEnv ?? {})) {
      process.env[name] = value;
    }
    await input.run({ argvLog });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    cleanupTempDir(shimDir);
    cleanupTempDir(stateHome);
  }
}

function shellRolesConfig() {
  return makeConfig({
    planner: { kind: 'shell', command: 'printf planner' },
    implementer: { kind: 'shell', command: 'printf implementer', model: 'shell-model' },
  });
}

describe('all-admitted-tools auth channels', () => {
  it.runIf(process.platform !== 'win32')(
    'probes every admitted CLI on its default channel when no CLI runner is active',
    async () => {
      await withAdmittedCliHost({
        shims: [...CLI_TOOL_IDS],
        sessionState: SEEDED_SESSION_STATE_PATHS,
        // Claude Code's default channel is `api-key` where its session
        // credential is not a bridgeable file, so both credential shapes have
        // to be present for every tool to report on the channel it defaults to.
        credentialEnv: { ANTHROPIC_API_KEY: 'sk-ant-fixture-not-a-real-key' },
        run: async () => {
          const result = await createProductionDetectionDeps({
            config: shellRolesConfig(),
            projectDir: '/projects/all-admitted-tools',
          }).detectAll({ signal: new AbortController().signal });

          expect(Object.fromEntries(result.cliTools.map(({ tool, auth }) => [tool, auth]))).toEqual(
            {
              'claude-code': 'authenticated',
              codex: 'authenticated',
              opencode: 'authenticated',
              aider: 'not-checked',
              copilot: 'authenticated',
              'kilo-code': 'authenticated',
            },
          );
          const copilot = result.cliTools.find((detection) => detection.tool === 'copilot');
          expect(copilot?.diagnostic).toEqual({ state: 'ready', remediation: null });
        },
      });
    },
    30_000,
  );

  it.runIf(process.platform !== 'win32')(
    'reports absent bridged session state as unauthenticated and unresolvable tools as unavailable',
    async () => {
      await withAdmittedCliHost({
        shims: ['copilot'],
        sessionState: [],
        run: async () => {
          const result = await createProductionDetectionDeps({
            config: shellRolesConfig(),
            projectDir: '/projects/absent-session-state',
          }).detectAll({ signal: new AbortController().signal });

          const byTool = new Map(result.cliTools.map((detection) => [detection.tool, detection]));
          expect(byTool.get('copilot')).toMatchObject({
            auth: 'unauthenticated',
            diagnostic: { state: 'unauthenticated' },
          });
          for (const tool of CLI_TOOL_IDS.filter((id) => id !== 'copilot')) {
            expect(byTool.get(tool)).toMatchObject({
              auth: 'not-checked',
              diagnostic: { state: 'unavailable' },
            });
          }
        },
      });
    },
    30_000,
  );

  it.runIf(process.platform !== 'win32')(
    'honors an explicit config auth channel over the session default for the active CLI',
    async () => {
      await withAdmittedCliHost({
        shims: ['codex'],
        sessionState: ['.codex/auth.json'],
        argvLogTool: 'codex',
        run: async ({ argvLog }) => {
          const config = makeConfig({
            planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
            implementer: { kind: 'shell', command: 'printf implementer', model: 'shell-model' },
          });
          const result = await createProductionDetectionDeps({
            config,
            projectDir: '/projects/override-auth-channel',
          }).detectAll({ signal: new AbortController().signal });

          const codex = result.cliTools.find((detection) => detection.tool === 'codex');
          expect(codex).toMatchObject({
            auth: 'unauthenticated',
            diagnostic: { state: 'unauthenticated' },
          });
          expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual(['--version']);
        },
      });
    },
    30_000,
  );
});

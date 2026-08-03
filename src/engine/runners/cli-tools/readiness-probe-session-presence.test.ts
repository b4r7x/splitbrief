import { chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { CliProbeContract, CliSessionPresenceProbe } from './contract.js';
import { providerOracleAuthFact } from './provider-oracle.js';
import { probeCliReadiness } from './readiness-probe.js';

async function nodeExecutable(): Promise<CliExecutableIdentity> {
  const path = await realpath(process.execPath);
  const info = await stat(path);
  return {
    path,
    fingerprint: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

function sessionProbe(
  options: {
    authScript?: string;
    authNotRun?: boolean;
    sessionPresence?: CliSessionPresenceProbe;
  } = {},
): CliProbeContract {
  const command = (script: string) =>
    ({
      command: ['node', '-e', script] as const,
      cwd: 'neutral' as const,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }) as const;
  const version = command("console.log('tool 1.0.0')");
  const auth = command(options.authScript ?? "console.log('verified')");
  return {
    version,
    auth,
    declared: {
      kind: 'declared',
      version: {
        ...version,
        kind: 'version',
        parse: () => ({ kind: 'success', value: '1.0.0' }),
      },
      auth: options.authNotRun
        ? { kind: 'not-run' }
        : {
            ...auth,
            kind: 'auth-status',
            parse: ({ stdout }) => (stdout.trim() === 'verified' ? 'verified' : 'invalid'),
          },
      catalog: { kind: 'not-run' },
      sessionPresence: options.sessionPresence ?? { kind: 'none' },
    },
  };
}

const KEYCHAIN = {
  kind: 'darwin-keychain',
  service: 'Claude Code-credentials',
} as const satisfies CliSessionPresenceProbe;

describe('session-state presence readiness', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('authenticates a keychain-backed session when no bridgeable state exists', async () => {
    await withTempDir('readiness-keychain-present', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);
      const keychainPresence = vi.fn(async () => true);

      const result = await probeCliReadiness({
        tool: 'claude-code',
        executable,
        authChannel: 'session',
        probe: sessionProbe({ sessionPresence: KEYCHAIN }),
        classifyVersion: () => 'compatible',
        keychainPresence,
      });

      expect(keychainPresence).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'Claude Code-credentials' }),
      );
      expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
    });
  });

  it('stays unauthenticated when neither bridgeable state nor a keychain entry exists', async () => {
    await withTempDir('readiness-keychain-absent', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);

      const result = await probeCliReadiness({
        tool: 'claude-code',
        executable,
        authChannel: 'session',
        probe: sessionProbe({ sessionPresence: KEYCHAIN }),
        classifyVersion: () => 'compatible',
        keychainPresence: async () => false,
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
    });
  });

  it('never lets keychain presence override an auth probe that ran against bridged state', async () => {
    await withTempDir('readiness-keychain-vs-probe', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.claude'), { recursive: true });
      await writeFile(join(hostHome, '.claude', '.credentials.json'), '{"session":"fixture"}');
      vi.stubEnv('HOME', hostHome);
      const keychainPresence = vi.fn(async () => true);

      const result = await probeCliReadiness({
        tool: 'claude-code',
        executable,
        authChannel: 'session',
        probe: sessionProbe({
          authScript: "console.log('logged out')",
          sessionPresence: KEYCHAIN,
        }),
        classifyVersion: () => 'compatible',
        keychainPresence,
      });

      expect(keychainPresence).not.toHaveBeenCalled();
      expect(result.status).not.toBe('ready');
    });
  });

  it('authenticates a probe-less session channel from bridged copilot state presence', async () => {
    await withTempDir('readiness-copilot-present', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.copilot'), { recursive: true });
      await writeFile(join(hostHome, '.copilot', 'config.json'), '{"loggedInUsers":["fixture"]}');
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('GH_TOKEN', '');
      vi.stubEnv('GITHUB_TOKEN', '');
      const keychainPresence = vi.fn(async () => true);

      const result = await probeCliReadiness({
        tool: 'copilot',
        executable,
        authChannel: 'session',
        probe: sessionProbe({ authNotRun: true }),
        classifyVersion: () => 'compatible',
        keychainPresence,
      });

      expect(keychainPresence).not.toHaveBeenCalled();
      expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
    });
  });

  it('keeps a probe-less session channel unauthenticated when no session state exists', async () => {
    await withTempDir('readiness-copilot-absent', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('GH_TOKEN', '');
      vi.stubEnv('GITHUB_TOKEN', '');

      const result = await probeCliReadiness({
        tool: 'copilot',
        executable,
        authChannel: 'session',
        probe: sessionProbe({ authNotRun: true }),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
    });
  });

  it('keeps probe-less bridge-free channels out of presence promotion', async () => {
    const executable = await nodeExecutable();
    vi.stubEnv('OPENAI_API_KEY', 'ambient-key');

    const result = await probeCliReadiness({
      tool: 'aider',
      executable,
      authChannel: 'provider-dependent',
      probe: sessionProbe({ authNotRun: true }),
      classifyVersion: () => 'compatible',
      keychainPresence: async () => true,
    });

    expect(result.auth).toBe('not-checked');
  });
});

const ORACLE_TOOLS = {
  opencode: {
    argv: ['opencode', 'providers', 'list'],
    stateFile: join('.local', 'share', 'opencode', 'auth.json'),
    report:
      '┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI \u001b[90moauth\n│\n└  1 credentials\n',
    facts: [{ provider: 'OpenAI', source: 'oauth' }],
  },
  'kilo-code': {
    argv: ['kilo', 'auth', 'list'],
    stateFile: join('.local', 'share', 'kilo', 'auth.json'),
    report:
      '┌  Credentials \u001b[90m~/.local/share/kilo/auth.json\n│\n●  GitHub Copilot \u001b[90moauth\n│\n└  1 credentials\n',
    facts: [{ provider: 'GitHub Copilot', source: 'oauth' }],
  },
} as const satisfies Record<
  string,
  Readonly<{
    argv: readonly [string, ...string[]];
    stateFile: string;
    report: string;
    facts: readonly unknown[];
  }>
>;

type OracleToolId = keyof typeof ORACLE_TOOLS;

async function oracleShim(dir: string, tool: OracleToolId, body: string) {
  const path = join(dir, ORACLE_TOOLS[tool].argv[0]);
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '0.5.0\\n'\n  exit 0\nfi\n${body}\n`,
  );
  await chmod(path, 0o755);
  const real = await realpath(path);
  const info = await stat(real);
  return {
    path: real,
    fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

function reportBody(tool: OracleToolId): string {
  return `cat <<'SPLITBRIEF_ORACLE'\n${ORACLE_TOOLS[tool].report}SPLITBRIEF_ORACLE\nexit 0`;
}

function oracleContract(tool: OracleToolId): CliProbeContract {
  const argv = ORACLE_TOOLS[tool].argv;
  const auth = {
    command: argv,
    cwd: 'neutral' as const,
    timeoutMs: 5_000,
    maxOutputBytes: 16_384,
  };
  const version = {
    command: [argv[0], '--version'] as const,
    cwd: 'neutral' as const,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  };
  return {
    version,
    auth,
    declared: {
      kind: 'declared',
      version: {
        ...version,
        kind: 'version',
        parse: () => ({ kind: 'success', value: '0.5.0' }),
      },
      auth: { ...auth, kind: 'auth-status', parse: providerOracleAuthFact },
      catalog: { kind: 'not-run' },
      sessionPresence: { kind: 'none' },
    },
  };
}

async function seedOracleState(hostHome: string, tool: OracleToolId): Promise<void> {
  const stateFile = ORACLE_TOOLS[tool].stateFile;
  await mkdir(join(hostHome, dirname(stateFile)), { recursive: true });
  await writeFile(join(hostHome, stateFile), '{"github-copilot":{"type":"oauth"}}');
}

describe.runIf(process.platform !== 'win32')('provider oracle three-way readiness', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubHostState(hostHome: string): void {
    vi.stubEnv('HOME', hostHome);
    vi.stubEnv('XDG_CONFIG_HOME', join(hostHome, 'xdg-config'));
    vi.stubEnv('XDG_DATA_HOME', join(hostHome, 'xdg-data'));
  }

  it.each([
    'opencode',
    'kilo-code',
  ] as const)('verifies %s from a clean oracle listing over bridged data-dir state and surfaces facts', async (tool) => {
    await withTempDir(`readiness-${tool}-oracle-verified`, async (hostHome) => {
      await seedOracleState(hostHome, tool);
      const executable = await oracleShim(hostHome, tool, reportBody(tool));
      stubHostState(hostHome);

      const result = await probeCliReadiness({
        tool,
        executable,
        authChannel: 'provider-dependent',
        probe: oracleContract(tool),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
      expect(result.providerAuth).toEqual(ORACLE_TOOLS[tool].facts);
    });
  });

  it.each([
    'opencode',
    'kilo-code',
  ] as const)('treats a clean zero-provider %s listing as a truthful negative over bridged presence', async (tool) => {
    await withTempDir(`readiness-${tool}-oracle-zero`, async (hostHome) => {
      await seedOracleState(hostHome, tool);
      const executable = await oracleShim(
        hostHome,
        tool,
        "printf '%s\\n' '┌  Credentials' '│' '└  0 credentials'\nexit 0",
      );
      stubHostState(hostHome);

      const result = await probeCliReadiness({
        tool,
        executable,
        authChannel: 'provider-dependent',
        probe: oracleContract(tool),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
      expect(result.providerAuth).toBeUndefined();
    });
  });

  it.each([
    'opencode',
    'kilo-code',
  ] as const)('falls back to bridged-state presence when the %s oracle cannot determine', async (tool) => {
    await withTempDir(`readiness-${tool}-oracle-fallback`, async (hostHome) => {
      await seedOracleState(hostHome, tool);
      const executable = await oracleShim(hostHome, tool, "echo 'oracle exploded' >&2\nexit 1");
      stubHostState(hostHome);

      const result = await probeCliReadiness({
        tool,
        executable,
        authChannel: 'provider-dependent',
        probe: oracleContract(tool),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
      expect(result.providerAuth).toBeUndefined();
    });
  });

  it.each([
    'opencode',
    'kilo-code',
  ] as const)('keeps %s unauthenticated when no allowlisted state reaches the sandboxed oracle', async (tool) => {
    await withTempDir(`readiness-${tool}-oracle-absent`, async (hostHome) => {
      const executable = await oracleShim(hostHome, tool, reportBody(tool));
      stubHostState(hostHome);
      const keychainPresence = vi.fn(async () => true);

      const result = await probeCliReadiness({
        tool,
        executable,
        authChannel: 'provider-dependent',
        probe: oracleContract(tool),
        classifyVersion: () => 'compatible',
        keychainPresence,
      });

      expect(keychainPresence).not.toHaveBeenCalled();
      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
    });
  });
});

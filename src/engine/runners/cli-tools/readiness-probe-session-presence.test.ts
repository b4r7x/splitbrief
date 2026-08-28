import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  capabilityTuple,
  unverifiedConformanceProof,
} from '#testing/helpers/factories/compiler-capability.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { CliProbeContract } from './contract.js';
import { providerOracleAuthFact } from './provider-oracle.js';
import { probeCliReadiness } from './readiness-probe.js';
import { admitCompilerCapability } from '../compiler-capability.js';

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
  options: { authScript?: string; authNotRun?: boolean; versionScript?: string } = {},
): CliProbeContract {
  const command = (script: string) =>
    ({
      command: ['node', '-e', script] as const,
      cwd: 'neutral' as const,
      // Spawning node under a fully parallel coverage run regularly costs more
      // than a second; a probe budget that small tests the machine's load, not
      // the verdict under test.
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    }) as const;
  const version = command(options.versionScript ?? "console.log('tool 1.0.0')");
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
            // Mirrors the shipped `parseStatusAuth`: a status command that says
            // it is signed out is a `missing` credential, and anything else it
            // could not classify is `invalid`.
            parse: ({ stdout }) => {
              const text = stdout.trim();
              if (text === 'verified') return 'verified';
              return text === 'missing' ? 'missing' : 'invalid';
            },
          },
      catalog: { kind: 'not-run' },
    },
  };
}

async function seedHostSessionState(
  hostHome: string,
  tool: 'claude-code' | 'cursor',
): Promise<string> {
  const relative =
    tool === 'claude-code'
      ? join('.claude', '.credentials.json')
      : join('.cursor', 'agent-cli-state.json');
  const path = join(hostHome, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{"session":"fixture"}');
  return path;
}

/**
 * Reports a session only when the staged child kept the host account. macOS
 * resolves the login keychain through `HOME` and keys the Claude Code and
 * Cursor session items on `USER`, so a fixture that answers `verified` under a
 * replaced home would let a sandbox that broke the keychain still pass for a
 * working subscription.
 */
function hostAccountAuthScript(hostHome: string): string {
  return `console.log(process.env.HOME === ${JSON.stringify(hostHome)} && (process.env.USER ?? '').length > 0 ? 'verified' : 'missing')`;
}

describe('session-state presence readiness', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // On macOS the Claude Code and Cursor session credentials are keychain
  // items, so no file in the staged environment can answer for them. The
  // tool's own status command is the only authority — in both directions.
  //
  // Those channels are host-account on darwin alone, so the platform is forced
  // rather than the block skipped: the probe target is a node fixture and the
  // host home is a temporary directory, so nothing here consults a real
  // keychain and every machine running the suite enforces the contract.
  describe('keychain-backed session channel', () => {
    const hostPlatform = process.platform;
    const setPlatform = (value: NodeJS.Platform): void => {
      Object.defineProperty(process, 'platform', { value, configurable: true });
    };

    beforeEach(() => {
      setPlatform('darwin');
    });
    afterEach(() => {
      setPlatform(hostPlatform);
    });

    it.each(['claude-code', 'cursor'] as const)(
      'asks %s itself, under the host account its keychain resolves through',
      async (tool) => {
        await withTempDir(`readiness-session-keychain-verified-${tool}`, async (hostHome) => {
          const executable = await nodeExecutable();
          vi.stubEnv('HOME', hostHome);

          const result = await probeCliReadiness({
            tool,
            executable,
            authChannel: 'session',
            // Nothing on disk says "authenticated" here, so a directory-reading
            // verdict could only be `missing`. Only the tool's own answer, given
            // the host account, produces this one.
            probe: sessionProbe({ authScript: hostAccountAuthScript(hostHome) }),
            classifyVersion: () => 'compatible',
          });

          expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
        });
      },
    );

    it.each(['claude-code', 'cursor'] as const)(
      'stays unauthenticated when %s reports no session, whatever the host home holds',
      async (tool) => {
        await withTempDir(`readiness-session-keychain-absent-${tool}`, async (hostHome) => {
          const executable = await nodeExecutable();
          // The host home now holds the file a file-bridged channel would carry.
          // It is not this channel's credential, and it must not outvote the tool.
          await seedHostSessionState(hostHome, tool);
          vi.stubEnv('HOME', hostHome);

          const result = await probeCliReadiness({
            tool,
            executable,
            authChannel: 'session',
            probe: sessionProbe({ authScript: "console.log('missing')" }),
            classifyVersion: () => 'compatible',
          });

          expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
          expect(result.remediation).toContain('macOS');
          expect(result.remediation).toContain('keychain');
          expect(result.remediation).toContain(`Sign in to ${tool}`);
        });
      },
    );

    it.each(['claude-code', 'cursor'] as const)(
      'refuses to guess %s when there is no status command to ask',
      async (tool) => {
        await withTempDir(`readiness-session-keychain-unknown-${tool}`, async (hostHome) => {
          const executable = await nodeExecutable();
          // A credential file in the host HOME is not the credential this channel
          // uses, and the sandbox roots hold only probe litter. With no status
          // command either, the only honest verdict is that nothing is known.
          await seedHostSessionState(hostHome, tool);
          vi.stubEnv('HOME', hostHome);

          const result = await probeCliReadiness({
            tool,
            executable,
            authChannel: 'session',
            probe: sessionProbe({ authNotRun: true }),
            classifyVersion: () => 'compatible',
          });

          expect(result).toMatchObject({ auth: 'unknown', status: 'unverified' });
        });
      },
    );

    it.each(['claude-code', 'cursor'] as const)(
      'leaves the host %s credential file the probe now runs beside untouched',
      async (tool) => {
        await withTempDir(`readiness-session-keychain-host-state-${tool}`, async (hostHome) => {
          const executable = await nodeExecutable();
          // This channel hands the child the real home, and the sandbox clears
          // this exact relative path before every run. The clear is confined to
          // the sandbox roots; if it ever followed the staged HOME instead, a
          // readiness probe would delete the user's own login.
          const credential = await seedHostSessionState(hostHome, tool);
          vi.stubEnv('HOME', hostHome);

          await probeCliReadiness({
            tool,
            executable,
            authChannel: 'session',
            probe: sessionProbe({ authScript: hostAccountAuthScript(hostHome) }),
            classifyVersion: () => 'compatible',
          });

          expect(await readFile(credential, 'utf8')).toBe('{"session":"fixture"}');
        });
      },
    );
  });

  it('never lets a bridged session file outvote the tool’s own status command', async () => {
    await withTempDir('readiness-session-bridged', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.copilot'), { recursive: true });
      await writeFile(join(hostHome, '.copilot', 'config.json'), '{"loggedInUsers":["fixture"]}');
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('GH_TOKEN', '');
      vi.stubEnv('GITHUB_TOKEN', '');

      const result = await probeCliReadiness({
        tool: 'copilot',
        executable,
        authChannel: 'session',
        probe: sessionProbe({ authScript: "console.log('logged out')" }),
        classifyVersion: () => 'compatible',
      });

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

      const result = await probeCliReadiness({
        tool: 'copilot',
        executable,
        authChannel: 'session',
        probe: sessionProbe({ authNotRun: true }),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
    });
  });

  it('does not read a probe-less session channel as authenticated from the probe’s own litter', async () => {
    await withTempDir('readiness-copilot-litter', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('GH_TOKEN', '');
      vi.stubEnv('GITHUB_TOKEN', '');

      const result = await probeCliReadiness({
        tool: 'copilot',
        executable,
        authChannel: 'session',
        // The version probe writes a file into the sandbox HOME, exactly as the
        // real Claude Code binary does during a readiness run. Reading that as
        // a credential is what certified a dead configuration as authenticated.
        probe: sessionProbe({
          authNotRun: true,
          versionScript:
            "require('node:fs').writeFileSync(process.env.HOME + '/probe-litter.json', '{}');console.log('tool 1.0.0')",
        }),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
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
    });

    expect(result.auth).toBe('not-checked');
  });
});

const ORACLE_TOOLS = {
  opencode: {
    argv: ['opencode', 'providers', 'list'],
    stateFile: join('.local', 'share', 'opencode', 'auth.json'),
    report:
      '┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n◝  OpenAI \u001b[90moauth\n│\n└  1 credentials\n',
    facts: [{ provider: 'OpenAI', source: 'oauth' }],
  },
  'kilo-code': {
    argv: ['kilo', 'auth', 'list'],
    stateFile: join('.local', 'share', 'kilo', 'auth.json'),
    report:
      '┌  Credentials \u001b[90m~/.local/share/kilo/auth.json\n│\n◝  GitHub Copilot \u001b[90moauth\n│\n└  1 credentials\n',
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

  it.each(['opencode', 'kilo-code'] as const)(
    'verifies %s from a clean oracle listing over bridged data-dir state and surfaces facts',
    async (tool) => {
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
        expect(result.providerAuth).toEqual({ kind: 'read', facts: ORACLE_TOOLS[tool].facts });
      });
    },
  );

  it.each(['opencode', 'kilo-code'] as const)(
    'treats a clean zero-provider %s listing as a truthful negative over bridged presence',
    async (tool) => {
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
        expect(result.providerAuth).toEqual({ kind: 'empty' });
      });
    },
  );

  it.each(['opencode', 'kilo-code'] as const)(
    'falls back to bridged-state presence when the %s oracle cannot determine',
    async (tool) => {
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
        expect(result.providerAuth).toEqual({ kind: 'unreadable', reason: 'exit-failure' });
      });
    },
  );

  it.each(['opencode', 'kilo-code'] as const)(
    'keeps %s unauthenticated when no allowlisted state reaches the sandboxed oracle',
    async (tool) => {
      await withTempDir(`readiness-${tool}-oracle-absent`, async (hostHome) => {
        const executable = await oracleShim(hostHome, tool, reportBody(tool));
        stubHostState(hostHome);

        const result = await probeCliReadiness({
          tool,
          executable,
          authChannel: 'provider-dependent',
          probe: oracleContract(tool),
          classifyVersion: () => 'compatible',
        });

        expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
      });
    },
  );

  it('a verified oracle listing never admits compiler capability without exact conformance', async () => {
    await withTempDir('readiness-oracle-capability', async (hostHome) => {
      await seedOracleState(hostHome, 'opencode');
      const executable = await oracleShim(hostHome, 'opencode', reportBody('opencode'));
      stubHostState(hostHome);

      const result = await probeCliReadiness({
        tool: 'opencode',
        executable,
        authChannel: 'provider-dependent',
        probe: oracleContract('opencode'),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
      const admission = admitCompilerCapability(
        capabilityTuple('opencode', {
          version: result.installedVersion ?? '',
          conformance: unverifiedConformanceProof(),
        }),
      );
      expect(admission.kind).toBe('refused');
      if (admission.kind === 'refused') expect(admission.missing).toEqual(['conformance']);
    });
  });
});

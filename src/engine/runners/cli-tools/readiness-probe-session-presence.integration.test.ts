import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { CliProbeContract } from './contract.js';
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
      : join('.config', 'cursor', 'auth.json');
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
  const hostPlatform = process.platform;
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    setPlatform(hostPlatform);
  });

  // On macOS the Claude Code, Cursor and Antigravity session credentials are
  // keychain items, so no file in the staged environment can answer for them.
  // The tool's own status command is the only authority — in both directions.
  //
  // Those channels are host-account on darwin alone, so the platform is forced
  // rather than the block skipped: the probe target is a node fixture and the
  // host home is a temporary directory, so nothing here consults a real
  // keychain and every machine running the suite enforces the contract.
  describe('keychain-backed session channel', () => {
    beforeEach(() => {
      setPlatform('darwin');
    });

    it.each(['claude-code', 'cursor', 'antigravity'] as const)(
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

    it.each([
      ['claude-code', 'Claude Code CLI'],
      ['cursor', 'Cursor Agent CLI'],
    ] as const)(
      'stays unauthenticated when %s reports no session, whatever the host home holds',
      async (tool, name) => {
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
          expect(result.remediation).toBe(
            `SPLITBRIEF looks for the ${name} session in the macOS keychain. Sign in to ${name}, then run \`splitbrief doctor\` again.`,
          );
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

  // On Linux Cursor keeps its sign-in in `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json`,
  // and the status fixture answers only from what the staged child can reach there.
  describe('file-bridged Cursor session on Linux', () => {
    const childSignInScript =
      "const p = require('node:path').join(process.env.XDG_CONFIG_HOME ?? '', 'cursor', 'auth.json'); console.log(require('node:fs').existsSync(p) ? 'verified' : 'missing')";

    beforeEach(() => {
      setPlatform('linux');
    });

    it('reads Cursor as signed in from the sign-in file in the host config folder', async () => {
      await withTempDir('readiness-cursor-linux-home', async (hostHome) => {
        await seedHostSessionState(hostHome, 'cursor');
        vi.stubEnv('HOME', hostHome);
        vi.stubEnv('XDG_CONFIG_HOME', '');

        const result = await probeCliReadiness({
          tool: 'cursor',
          executable: await nodeExecutable(),
          authChannel: 'session',
          probe: sessionProbe({ authScript: childSignInScript }),
          classifyVersion: () => 'compatible',
        });

        expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
      });
    });

    it('reads Cursor as signed in from the sign-in file under a set XDG_CONFIG_HOME', async () => {
      await withTempDir('readiness-cursor-linux-xdg', async (root) => {
        const hostHome = join(root, 'home');
        const hostConfig = join(root, 'config');
        await mkdir(join(hostConfig, 'cursor'), { recursive: true });
        await writeFile(join(hostConfig, 'cursor', 'auth.json'), '{"accessToken":"fixture"}');
        await mkdir(hostHome);
        vi.stubEnv('HOME', hostHome);
        vi.stubEnv('XDG_CONFIG_HOME', hostConfig);

        const result = await probeCliReadiness({
          tool: 'cursor',
          executable: await nodeExecutable(),
          authChannel: 'session',
          probe: sessionProbe({ authScript: childSignInScript }),
          classifyVersion: () => 'compatible',
        });

        expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
      });
    });

    it('reads Cursor as not signed in when the host holds only its UI state file', async () => {
      await withTempDir('readiness-cursor-linux-ui-state', async (hostHome) => {
        await mkdir(join(hostHome, '.cursor'), { recursive: true });
        await writeFile(join(hostHome, '.cursor', 'agent-cli-state.json'), '{"version":1}');
        vi.stubEnv('HOME', hostHome);
        vi.stubEnv('XDG_CONFIG_HOME', '');

        const result = await probeCliReadiness({
          tool: 'cursor',
          executable: await nodeExecutable(),
          authChannel: 'session',
          probe: sessionProbe({ authScript: "console.log('verified')" }),
          classifyVersion: () => 'compatible',
        });

        expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
      });
    });
  });

  it('never lets a bridged session file outvote the tool’s own status command', async () => {
    // Copilot bridges its files on Linux; on macOS its token is a keychain item.
    setPlatform('linux');
    await withTempDir('readiness-session-bridged', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.copilot'), { recursive: true });
      await writeFile(join(hostHome, '.copilot', 'config.json'), '{"loggedInUsers":["fixture"]}');
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('COPILOT_GITHUB_TOKEN', '');
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
    setPlatform('linux');
    await withTempDir('readiness-copilot-present', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.copilot'), { recursive: true });
      await writeFile(join(hostHome, '.copilot', 'config.json'), '{"loggedInUsers":["fixture"]}');
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('COPILOT_GITHUB_TOKEN', '');
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
    setPlatform('linux');
    await withTempDir('readiness-copilot-litter', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('COPILOT_GITHUB_TOKEN', '');
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
    setPlatform('linux');
    await withTempDir('readiness-copilot-absent', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('COPILOT_GITHUB_TOKEN', '');
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

  it.each(['keyring', 'auto'])(
    'names a Codex sign-in kept in the system keyring (%s store)',
    async (store) => {
      await withTempDir('readiness-codex-keyring', async (hostHome) => {
        const executable = await nodeExecutable();
        await mkdir(join(hostHome, '.codex'), { recursive: true });
        await writeFile(
          join(hostHome, '.codex', 'config.toml'),
          `model = "gpt-6-astra"\ncli_auth_credentials_store = "${store}"\n`,
        );
        vi.stubEnv('HOME', hostHome);
        vi.stubEnv('CODEX_HOME', '');

        const result = await probeCliReadiness({
          tool: 'codex',
          executable,
          authChannel: 'session',
          probe: sessionProbe(),
          classifyVersion: () => 'compatible',
        });

        expect(result).toMatchObject({ auth: 'keyring', status: 'unauthenticated' });
        expect(result.remediation).toBe(
          'Set cli_auth_credentials_store = "file" in config.toml and run codex login again, or use OPENAI_API_KEY, then run `splitbrief doctor` again.',
        );
      });
    },
  );

  it('asks for the API key on the Codex api-key channel when the session store is the keyring', async () => {
    await withTempDir('readiness-codex-keyring-api-key', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.codex'), { recursive: true });
      await writeFile(
        join(hostHome, '.codex', 'config.toml'),
        'cli_auth_credentials_store = "keyring"\n',
      );
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('CODEX_HOME', '');
      vi.stubEnv('OPENAI_API_KEY', '');

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        authChannel: 'api-key',
        probe: sessionProbe(),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
      expect(result.remediation).toBe(
        'Export OPENAI_API_KEY for OpenAI Codex CLI, then run `splitbrief doctor` again.',
      );
    });
  });

  it('keeps a Codex file store with no auth.json signed out', async () => {
    await withTempDir('readiness-codex-file-store', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.codex'), { recursive: true });
      await writeFile(
        join(hostHome, '.codex', 'config.toml'),
        '[profiles.work]\ncli_auth_credentials_store = "keyring"\n',
      );
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('CODEX_HOME', '');

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        authChannel: 'session',
        probe: sessionProbe(),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
    });
  });

  it('keeps probe-less bridge-free channels out of presence promotion', async () => {
    const executable = await nodeExecutable();
    vi.stubEnv('OPENAI_API_KEY', 'ambient-key');

    const result = await probeCliReadiness({
      tool: 'codex',
      executable,
      authChannel: 'api-key',
      probe: sessionProbe({ authNotRun: true }),
      classifyVersion: () => 'compatible',
    });

    expect(result.auth).toBe('not-checked');
  });

  it('does not verify a macOS Copilot sign-in from its config file', async () => {
    setPlatform('darwin');
    await withTempDir('readiness-copilot-darwin', async (hostHome) => {
      const executable = await nodeExecutable();
      // On macOS `config.json` lists the signed-in users, and the token itself
      // is a keychain item no file check can see.
      await mkdir(join(hostHome, '.copilot'), { recursive: true });
      await writeFile(join(hostHome, '.copilot', 'config.json'), '{"loggedInUsers":["fixture"]}');
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('COPILOT_GITHUB_TOKEN', '');
      vi.stubEnv('GH_TOKEN', '');
      vi.stubEnv('GITHUB_TOKEN', '');

      const result = await probeCliReadiness({
        tool: 'copilot',
        executable,
        authChannel: 'session',
        probe: sessionProbe({ authNotRun: true }),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'unknown', status: 'unverified' });
    });
  });

  it('counts COPILOT_GITHUB_TOKEN as a Copilot credential', async () => {
    setPlatform('linux');
    await withTempDir('readiness-copilot-token', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('COPILOT_GITHUB_TOKEN', 'github_pat_readiness_fixture');
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

  it('does not verify Copilot from a Copilot IDE-plugin file alone', async () => {
    setPlatform('linux');
    await withTempDir('readiness-copilot-ide-plugin', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.config', 'github-copilot'), { recursive: true });
      await writeFile(
        join(hostHome, '.config', 'github-copilot', 'apps.json'),
        '{"github.com:Iv1":{"oauth_token":"ide-plugin-fixture"}}',
      );
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('XDG_CONFIG_HOME', '');
      vi.stubEnv('COPILOT_GITHUB_TOKEN', '');
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
});

const ORACLE_TOOLS = {
  opencode: {
    argv: ['opencode', 'auth', 'list', '--standalone', '--format', 'json'],
    // OpenCode reads `$XDG_DATA_HOME/opencode`, which `stubHostState` sets.
    stateFile: join('xdg-data', 'opencode', 'auth.json'),
    report:
      '[{"id":"openai","name":"OpenAI","connections":[{"type":"credential","id":"cred_0001","label":"default"}]}]\n',
    facts: [{ id: 'openai', provider: 'OpenAI', source: 'stored' }],
  },
  'kilo-code': {
    argv: ['kilo', 'auth', 'list'],
    // Kilo Code reads `$XDG_DATA_HOME/kilo`, which `stubHostState` sets.
    stateFile: join('xdg-data', 'kilo', 'auth.json'),
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
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '${CLI_TOOL_CATALOG[tool].compatibility.testedVersion}\\n'\n  exit 0\nfi\n${body}\n`,
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
        parse: () => ({
          kind: 'success',
          value: CLI_TOOL_CATALOG[tool].compatibility.testedVersion,
        }),
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

  /**
   * A provider-dependent channel keeps every `*_API_KEY` the process carries,
   * so a machine that has one of its own would hand these cases a credential
   * they never seeded. Blank them to make "no state reaches the oracle" mean it.
   */
  function stubNoProviderKeys(): void {
    for (const key of Object.keys(process.env)) {
      if (key.endsWith('_API_KEY')) vi.stubEnv(key, '');
    }
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
    'keeps %s unauthenticated when its own listing names no provider and no state or key exists',
    async (tool) => {
      await withTempDir(`readiness-${tool}-oracle-absent`, async (hostHome) => {
        const executable = await oracleShim(
          hostHome,
          tool,
          "printf '%s\\n' '┌  Credentials' '│' '└  0 credentials'\nexit 0",
        );
        stubHostState(hostHome);
        stubNoProviderKeys();

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

  it('verifies opencode from its own listing when the sign-in lives only in opencode.db', async () => {
    await withTempDir('readiness-opencode-oracle-db-only', async (hostHome) => {
      // OpenCode 2 writes `opencode auth login` to its database and never to auth.json.
      await mkdir(join(hostHome, 'xdg-data', 'opencode'), { recursive: true });
      await writeFile(join(hostHome, 'xdg-data', 'opencode', 'opencode.db'), 'fixture');
      const executable = await oracleShim(
        hostHome,
        'opencode',
        `if [ -f "$XDG_DATA_HOME/opencode/opencode.db" ]; then\n${reportBody('opencode')}\nfi\nprintf '[]\\n'\nexit 0`,
      );
      stubHostState(hostHome);
      stubNoProviderKeys();

      const result = await probeCliReadiness({
        tool: 'opencode',
        executable,
        authChannel: 'provider-dependent',
        probe: oracleContract('opencode'),
        classifyVersion: () => 'compatible',
      });

      expect(result).toMatchObject({ auth: 'authenticated', status: 'ready' });
      expect(result.providerAuth).toEqual({ kind: 'read', facts: ORACLE_TOOLS.opencode.facts });
    });
  });
});

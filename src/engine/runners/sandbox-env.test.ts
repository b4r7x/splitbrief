import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import {
  cliAuthChannelHostStateAccess,
  type CliAuthChannel,
} from '../../core/runners/cli-tool-catalog.js';
import {
  cliAuthChannelEnvKeys,
  createRunnerSandboxEnv,
  createSandboxEnv,
  prependCliExecutableDirectory,
  resolveCliRunnerAuth,
  runnerAuthEnvKeys,
  runnerSandboxIdentity,
  withPrependedPathDirectory,
} from './sandbox-env.js';
import { sandboxCredentialValues } from './sandbox-credential-values.js';
import { bridgedCliStatePresent, clearBridgedCliState } from './sandbox-state-bridge.js';
import { createRunnerCallCredentialRedactor } from '../calls/status.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];
const originalEnvValues = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!originalEnvValues.has(key)) originalEnvValues.set(key, process.env[key]);
  process.env[key] = value;
}

function unsetEnv(key: string): void {
  if (!originalEnvValues.has(key)) originalEnvValues.set(key, process.env[key]);
  delete process.env[key];
}

afterEach(() => {
  for (const [key, value] of originalEnvValues) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvValues.clear();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function authChannel(over: Partial<CliAuthChannel>): CliAuthChannel {
  return {
    id: 'session',
    env: [],
    stateBridge: 'host-cli-state',
    billing: 'subscription-included',
    hostKeychainPlatforms: [],
    ...over,
  };
}

describe('prependCliExecutableDirectory', () => {
  it('prepends the executable directory while preserving the safe runtime interpreter PATH', () => {
    const executableDir = createTempDir('sandbox-path-executable');
    const interpreterDir = createTempDir('sandbox-path-interpreter');
    const utilityDir = createTempDir('sandbox-path-utility');
    dirs.push(executableDir, interpreterDir, utilityDir);

    const path = prependCliExecutableDirectory({
      executablePath: join(executableDir, 'runner-cli'),
      safeRuntimePath: [interpreterDir, utilityDir, interpreterDir, 'relative-shadow'].join(
        delimiter,
      ),
    });

    expect(path.split(delimiter)).toEqual([executableDir, interpreterDir, utilityDir]);
  });

  it('rejects a non-absolute executable path', () => {
    expect(() =>
      prependCliExecutableDirectory({
        executablePath: 'runner-cli',
        safeRuntimePath: '/usr/bin',
      }),
    ).toThrow(/must be absolute/u);
  });
});

describe('withPrependedPathDirectory', () => {
  it('returns a new env with the directory first and only absolute de-duplicated PATH entries', () => {
    const first = createTempDir('sandbox-prepend-first');
    const second = createTempDir('sandbox-prepend-second');
    dirs.push(first, second);
    const env: NodeJS.ProcessEnv = {
      PATH: [second, first, second, 'relative-shadow'].join(delimiter),
    };

    const result = withPrependedPathDirectory(env, first);

    expect(result).not.toBe(env);
    expect(result.PATH?.split(delimiter)).toEqual([first, second]);
    expect(env.PATH).toBe([second, first, second, 'relative-shadow'].join(delimiter));
  });

  it('keeps credential redaction values attached through the prepend', async () => {
    const hostHome = createTempDir('sandbox-prepend-creds-host');
    const projectDir = createTempDir('sandbox-prepend-creds-project');
    const binDir = createTempDir('sandbox-prepend-bin');
    dirs.push(hostHome, projectDir, binDir);
    const credential = 'prepend-bridged-canary-4f9d';
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), JSON.stringify({ token: credential }));
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );
    const result = withPrependedPathDirectory(env, binDir);

    expect(result.PATH?.split(delimiter)[0]).toBe(binDir);
    expect(sandboxCredentialValues(result)).toContain(credential);
    expect(Object.keys(result)).not.toContain(credential);
    expect(Object.values(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it('rejects a non-absolute directory', () => {
    expect(() => withPrependedPathDirectory({ PATH: '/usr/bin' }, 'node_modules/.bin')).toThrow(
      /must be absolute/u,
    );
  });
});

describe('createSandboxEnv', () => {
  it('redirects HOME/XDG/cache env to fresh sandbox dirs', async () => {
    const projectDir = createTempDir('sandbox-env');
    dirs.push(projectDir);

    const env = await createSandboxEnv({ projectDir });

    const root = join(projectDir, SANDBOX_DIR);
    expect(env.HOME).toBe(join(root, 'home'));
    expect(env.XDG_CONFIG_HOME).toBe(join(root, 'config'));
    expect(env.XDG_CACHE_HOME).toBe(join(root, 'cache'));
    expect(env.npm_config_cache).toBe(join(root, 'npm-cache'));
    expect(existsSync(join(root, 'home'))).toBe(true);
  });

  itUnix('does not symlink tool credential dirs into the sandbox HOME', async () => {
    const fakeHome = createTempDir('sandbox-real-home');
    const projectDir = createTempDir('sandbox-env-creds');
    dirs.push(fakeHome, projectDir);

    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', '.credentials.json'), '{"token":"secret"}');

    setEnv('HOME', fakeHome);

    const env = await createSandboxEnv({ projectDir });

    const sandboxHome = env.HOME as string;
    expect(existsSync(join(sandboxHome, '.claude'))).toBe(false);
    expect(existsSync(join(sandboxHome, '.codex'))).toBe(false);
    expect(existsSync(join(sandboxHome, '.copilot'))).toBe(false);
  });

  itUnix('does not seed writable credential files into the sandbox HOME', async () => {
    const fakeHome = createTempDir('sandbox-real-home');
    const projectDir = createTempDir('sandbox-env-no-creds');
    dirs.push(fakeHome, projectDir);

    writeFileSync(join(fakeHome, '.npmrc'), '//registry/:_authToken=abc\n');
    writeFileSync(join(fakeHome, '.netrc'), 'machine example.com login user password pass\n');

    setEnv('HOME', fakeHome);

    const env = await createSandboxEnv({ projectDir });

    const sandboxHome = env.HOME as string;
    expect(existsSync(join(sandboxHome, '.npmrc'))).toBe(false);
    expect(existsSync(join(sandboxHome, '.netrc'))).toBe(false);
  });

  itUnix('bridges nothing when the real HOME has no credential entries', async () => {
    const fakeHome = createTempDir('sandbox-empty-home');
    const projectDir = createTempDir('sandbox-env-empty');
    dirs.push(fakeHome, projectDir);
    setEnv('HOME', fakeHome);

    const env = await createSandboxEnv({ projectDir, selectedCli: 'claude-code' });

    expect(await bridgedCliStatePresent(env, 'claude-code')).toBe(false);
    expect(sandboxCredentialValues(env)).toEqual([]);
  });

  itUnix('points a Copilot child at the account package cache, not a redirect', async () => {
    const redirectedHome = createTempDir('sandbox-copilot-redirected-home');
    const relocated = createTempDir('sandbox-copilot-relocated-cache');
    const projectDir = createTempDir('sandbox-copilot-cache');
    dirs.push(redirectedHome, relocated, projectDir);
    setEnv('HOME', redirectedHome);
    unsetEnv('XDG_CACHE_HOME');
    unsetEnv('COPILOT_CACHE_HOME');

    const fromAccountHome = await createSandboxEnv({ projectDir, selectedCli: 'copilot' });
    setEnv('COPILOT_CACHE_HOME', relocated);
    const fromRelocatedCache = await createSandboxEnv({ projectDir, selectedCli: 'copilot' });
    const otherTool = await createSandboxEnv({ projectDir, selectedCli: 'claude-code' });

    // The launcher resolves the build it execs from this directory, so a
    // sandbox-local one downgrades Copilot to the build embedded in it — and a
    // directory derived from an already-redirected `$HOME` is sandbox-local by
    // another name: it holds no package, so the launcher unpacks 67 MB into it.
    expect(fromAccountHome.COPILOT_CACHE_HOME?.startsWith(userInfo().homedir)).toBe(true);
    expect(fromAccountHome.COPILOT_CACHE_HOME?.startsWith(redirectedHome)).toBe(false);
    expect(fromRelocatedCache.COPILOT_CACHE_HOME).toBe(relocated);
    expect(otherTool.COPILOT_CACHE_HOME).toBeUndefined();
    expect(fromAccountHome.XDG_CACHE_HOME).toBe(join(projectDir, SANDBOX_DIR, 'cache'));
  });

  itUnix('hands a host-account channel the real HOME and USER and nothing else', async () => {
    const hostHome = createTempDir('sandbox-host-account-home');
    const projectDir = createTempDir('sandbox-host-account');
    dirs.push(hostHome, projectDir);
    setEnv('HOME', hostHome);

    const env = await createSandboxEnv({
      projectDir,
      selectedCli: 'claude-code',
      hostState: 'host-account',
    });

    const root = join(projectDir, SANDBOX_DIR);
    expect(env.HOME).toBe(hostHome);
    expect(env.USERPROFILE).toBe(hostHome);
    expect(env.USER).toBe(userInfo().username);
    // Only the account is real. Everything the sandbox redirects for cache and
    // temp isolation still points inside the project.
    expect(env.TMPDIR).toBe(join(root, 'tmp'));
    expect(env.XDG_CONFIG_HOME).toBe(join(root, 'config'));
    expect(env.XDG_DATA_HOME).toBe(join(root, 'data'));
    expect(env.XDG_CACHE_HOME).toBe(join(root, 'cache'));
    expect(env.npm_config_cache).toBe(join(root, 'npm-cache'));
    expect(env.PIP_CACHE_DIR).toBe(join(root, 'pip-cache'));
    expect(env.CARGO_HOME).toBe(join(root, 'cargo'));
  });

  itUnix('copies no credential into the sandbox for a host-account channel', async () => {
    const hostHome = createTempDir('sandbox-host-account-nocopy-home');
    const projectDir = createTempDir('sandbox-host-account-nocopy');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(
      join(hostHome, '.claude', '.credentials.json'),
      '{"token":"host-account-canary"}',
    );
    setEnv('HOME', hostHome);

    const env = await createSandboxEnv({
      projectDir,
      selectedCli: 'claude-code',
      hostState: 'host-account',
    });

    // The keychain is what such a channel reads, so no snapshot is staged and
    // no credential value is registered for parent-side redaction.
    expect(existsSync(join(projectDir, SANDBOX_DIR, 'home', '.claude'))).toBe(false);
    expect(sandboxCredentialValues(env)).toEqual([]);
  });

  itUnix('routes a Claude Code session runner by the channel the catalog declares', async () => {
    const hostHome = createTempDir('sandbox-session-route-home');
    const projectDir = createTempDir('sandbox-session-route');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"session":"fixture"}');
    setEnv('HOME', hostHome);

    const runner = { kind: 'cli', tool: 'claude-code', authChannel: 'session' } as const;
    const env = await createRunnerSandboxEnv(projectDir, runner, 'planner');

    const roleHome = join(projectDir, SANDBOX_DIR, 'planner', 'claude-code', 'home');
    const staged = join(roleHome, '.claude', '.credentials.json');
    if (cliAuthChannelHostStateAccess(resolveCliRunnerAuth(runner)) === 'host-account') {
      expect(env.HOME).toBe(hostHome);
      expect(existsSync(staged)).toBe(false);
    } else {
      expect(env.HOME).toBe(roleHome);
      expect(existsSync(staged)).toBe(true);
      expect(await bridgedCliStatePresent(env, 'claude-code')).toBe(true);
    }
  });

  itUnix('routes a Cursor session runner by the channel the catalog declares', async () => {
    const hostHome = createTempDir('sandbox-cursor-session-route-home');
    const projectDir = createTempDir('sandbox-cursor-session-route');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.cursor'), { recursive: true });
    writeFileSync(join(hostHome, '.cursor', 'agent-cli-state.json'), '{"session":"fixture"}');
    setEnv('HOME', hostHome);

    const runner = { kind: 'cli', tool: 'cursor', authChannel: 'session' } as const;
    const env = await createRunnerSandboxEnv(projectDir, runner, 'planner');

    const roleHome = join(projectDir, SANDBOX_DIR, 'planner', 'cursor', 'home');
    const staged = join(roleHome, '.cursor', 'agent-cli-state.json');
    if (cliAuthChannelHostStateAccess(resolveCliRunnerAuth(runner)) === 'host-account') {
      expect(env.HOME).toBe(hostHome);
      expect(existsSync(staged)).toBe(false);
    } else {
      expect(env.HOME).toBe(roleHome);
      expect(existsSync(staged)).toBe(true);
      expect(await bridgedCliStatePresent(env, 'cursor')).toBe(true);
    }
  });

  it('secret canaries and unrelated ambient values are absent from the sandbox env', async () => {
    const projectDir = createTempDir('sandbox-env-secrets');
    dirs.push(projectDir);
    setEnv('GITHUB_TOKEN', 'gh-secret');
    setEnv('XAI_API_KEY', 'xai-secret');
    setEnv('DATABASE_PASSWORD', 'db-secret');
    setEnv('DATABASE_URL', 'postgres://user:pass@host/db');
    setEnv('REDIS_URL', 'redis://:pass@host:6379');
    setEnv('MONGODB_URI', 'mongodb://user:pass@host/db');
    setEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    setEnv('SPLITBRIEF_PUBLIC_FLAG', 'keep-me');

    const env = await createSandboxEnv({ projectDir });

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_PASSWORD).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.MONGODB_URI).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SPLITBRIEF_PUBLIC_FLAG).toBeUndefined();
  });

  it('strips ambient credential handle env vars', async () => {
    const projectDir = createTempDir('sandbox-env-handles');
    dirs.push(projectDir);
    setEnv('AWS_PROFILE', 'prod');
    setEnv('AWS_SHARED_CREDENTIALS_FILE', '/home/user/.aws/credentials');
    setEnv('AWS_WEB_IDENTITY_TOKEN_FILE', '/var/run/secrets/token');
    setEnv('GOOGLE_APPLICATION_CREDENTIALS', '/home/user/gcp.json');
    setEnv('GIT_ASKPASS', '/usr/bin/askpass');
    setEnv('SSH_AUTH_SOCK', '/tmp/ssh-agent.sock');
    setEnv('NPM_CONFIG_USERCONFIG', '/home/user/.npmrc');
    setEnv('npm_config_userconfig', '/home/user/.npmrc');
    setEnv('CUSTOM_TOKEN_FILE', '/tmp/custom-token');

    const env = await createSandboxEnv({ projectDir, preserveEnvKeys: ['CUSTOM_TOKEN_FILE'] });

    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(env.npm_config_userconfig).toBeUndefined();
    expect(env.CUSTOM_TOKEN_FILE).toBe('/tmp/custom-token');
  });

  it("allowlist preserves the configured runner's own auth key while stripping other secrets", async () => {
    const projectDir = createTempDir('sandbox-env-preserve');
    dirs.push(projectDir);
    setEnv('OPENAI_API_KEY', 'sk-openai');
    setEnv('ANTHROPIC_API_KEY', 'sk-anthropic');
    setEnv('XAI_API_KEY', 'sk-xai');

    const env = await createSandboxEnv({ projectDir, preserveEnvKeys: ['OPENAI_API_KEY'] });

    expect(env.OPENAI_API_KEY).toBe('sk-openai');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it('allowlist strips loaders, startup hooks, cwd values, real HOME, and project PATH', async () => {
    const projectDir = createTempDir('sandbox-env-allowlist-canary');
    const safeBin = createTempDir('sandbox-env-allowlist-bin');
    dirs.push(projectDir, safeBin);
    const projectBin = join(projectDir, 'bin');
    mkdirSync(projectBin);
    setEnv('PATH', [projectBin, '.', safeBin].join(delimiter));
    setEnv('HOME', '/real/home/canary');
    setEnv('PWD', '/cwd/canary');
    setEnv('OLDPWD', '/old/cwd/canary');
    setEnv('INIT_CWD', '/init/cwd/canary');
    setEnv('NODE_OPTIONS', '--require=/tmp/canary-loader.js');
    setEnv('NODE_PATH', '/tmp/canary-modules');
    setEnv('PYTHONPATH', '/tmp/canary-python');
    setEnv('BASH_ENV', '/tmp/canary-startup');
    setEnv('ZDOTDIR', '/tmp/canary-zdotdir');
    setEnv('LD_PRELOAD', '/tmp/canary.so');
    setEnv('LANG', 'C.UTF-8');
    setEnv('TERM', 'xterm-256color');

    const env = await createSandboxEnv({ projectDir });

    expect(env.LANG).toBe('C.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.HOME).toBe(join(projectDir, SANDBOX_DIR, 'home'));
    expect(env.PWD).toBeUndefined();
    expect(env.OLDPWD).toBeUndefined();
    expect(env.INIT_CWD).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.ZDOTDIR).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.PATH?.split(delimiter)).not.toContain(projectBin);
    expect(env.PATH?.split(delimiter)).not.toContain('.');
    expect(env.PATH).toContain(realpathSync(safeBin));
    expect(Object.values(env)).not.toContain('/real/home/canary');
  });

  it('allowlist cannot promote process-control variables to auth channels', async () => {
    const projectDir = createTempDir('sandbox-env-control-auth');
    dirs.push(projectDir);
    setEnv('NODE_OPTIONS', '--require=/tmp/canary-loader.js');
    setEnv('GIT_ASKPASS', '/tmp/canary-askpass');

    const env = await createSandboxEnv({
      projectDir,
      preserveEnvKeys: ['NODE_OPTIONS', 'GIT_ASKPASS'],
    });

    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
  });
});

describe('bridgedCliStatePresent', () => {
  itUnix(
    'reports the bridged destination file, not whatever else the sandbox roots hold',
    async () => {
      const fakeHome = createTempDir('sandbox-bridged-host');
      const projectDir = createTempDir('sandbox-bridged-project');
      dirs.push(fakeHome, projectDir);
      setEnv('HOME', fakeHome);

      const env = await createSandboxEnv({ projectDir, selectedCli: 'claude-code' });
      expect(await bridgedCliStatePresent(env, 'claude-code')).toBe(false);

      // What the child itself writes during a probe — Claude Code drops
      // `.claude.json` and a backup — must never read as a credential.
      const sandboxHome = env.HOME as string;
      mkdirSync(join(sandboxHome, '.claude', 'backups'), { recursive: true });
      writeFileSync(join(sandboxHome, '.claude.json'), '{}');
      writeFileSync(join(sandboxHome, '.claude', 'backups', '.claude.json.backup.1'), '{}');
      expect(await bridgedCliStatePresent(env, 'claude-code')).toBe(false);
    },
  );

  itUnix('reports a credential that the bridge actually copied in', async () => {
    const fakeHome = createTempDir('sandbox-bridged-host-real');
    const projectDir = createTempDir('sandbox-bridged-project-real');
    dirs.push(fakeHome, projectDir);
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', '.credentials.json'), '{"session":"fixture"}');
    setEnv('HOME', fakeHome);

    const env = await createSandboxEnv({ projectDir, selectedCli: 'claude-code' });

    expect(await bridgedCliStatePresent(env, 'claude-code')).toBe(true);
    expect(await bridgedCliStatePresent(env, 'codex')).toBe(false);
  });

  itUnix('does not count a symlink planted at the bridged destination', async () => {
    const fakeHome = createTempDir('sandbox-bridged-host-symlink');
    const projectDir = createTempDir('sandbox-bridged-project-symlink');
    dirs.push(fakeHome, projectDir);
    setEnv('HOME', fakeHome);
    const bait = join(fakeHome, 'host-credential.json');
    writeFileSync(bait, '{"token":"host"}');

    const env = await createSandboxEnv({ projectDir, selectedCli: 'claude-code' });
    const destination = join(env.HOME as string, '.claude', '.credentials.json');
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(bait, destination);

    expect(await bridgedCliStatePresent(env, 'claude-code')).toBe(false);
  });
});

describe('cliAuthChannelEnvKeys', () => {
  it('passes every provider API key to a provider-dependent tool', () => {
    expect(
      cliAuthChannelEnvKeys(
        authChannel({ id: 'provider-dependent', billing: 'provider-dependent' }),
        { OLLAMA_API_KEY: 'k', KIMI_API_KEY: 'k', PATH: '/bin', HOME: '/h' },
      ),
    ).toEqual(['OLLAMA_API_KEY', 'KIMI_API_KEY']);
  });

  it('keeps a metered channel to the keys it declares', () => {
    expect(
      cliAuthChannelEnvKeys(
        authChannel({
          id: 'api-key',
          env: ['ANTHROPIC_API_KEY'],
          stateBridge: 'none',
          billing: 'api-metered',
        }),
        { OLLAMA_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' },
      ),
    ).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('leaves a subscription session channel scrubbed', () => {
    expect(cliAuthChannelEnvKeys(authChannel({}), { OLLAMA_API_KEY: 'k' })).toEqual([]);
  });

  it('preserves nothing when the channel is undefined', () => {
    expect(cliAuthChannelEnvKeys(undefined, { OLLAMA_API_KEY: 'k' })).toEqual([]);
  });

  it('lists a declared key of a provider-dependent channel exactly once', () => {
    expect(
      cliAuthChannelEnvKeys(
        authChannel({
          id: 'provider-dependent',
          env: ['OPENCODE_API_KEY'],
          billing: 'provider-dependent',
        }),
        { OPENCODE_API_KEY: 'x', OLLAMA_API_KEY: 'y' },
      ),
    ).toEqual(['OPENCODE_API_KEY', 'OLLAMA_API_KEY']);
  });
});

describe('runnerAuthEnvKeys', () => {
  it('resolves an unset CLI auth channel from the descriptor, never from ambient credentials', () => {
    const claudeCode = { kind: 'cli', tool: 'claude-code', model: 'auto' } as const;
    const codex = { kind: 'cli', tool: 'codex' } as const;

    expect(runnerAuthEnvKeys(claudeCode)).toEqual([]);
    expect(runnerAuthEnvKeys(codex)).toEqual([]);

    setEnv('ANTHROPIC_API_KEY', 'sk-anthropic');
    setEnv('OPENAI_API_KEY', 'sk-openai');

    expect(runnerAuthEnvKeys(claudeCode)).toEqual([]);
    expect(runnerAuthEnvKeys(codex)).toEqual([]);
    // The default is the declared session channel, whose bridge copies only
    // the allowlisted state snapshot - never env credentials, never host HOME.
    expect(resolveCliRunnerAuth(claudeCode).id).toBe('session');
    expect(resolveCliRunnerAuth(codex).id).toBe('session');
    expect(resolveCliRunnerAuth(claudeCode).env).toEqual([]);
    expect(resolveCliRunnerAuth(codex).env).toEqual([]);
  });

  it('maps only the explicitly selected CLI auth channel', () => {
    expect(
      runnerAuthEnvKeys({
        kind: 'cli',
        tool: 'claude-code',
        model: 'auto',
        authChannel: 'api-key',
      }),
    ).toEqual(['ANTHROPIC_API_KEY']);
    expect(runnerAuthEnvKeys({ kind: 'cli', tool: 'codex', authChannel: 'session' })).toEqual([]);
    expect(runnerAuthEnvKeys({ kind: 'cli', tool: 'codex', authChannel: 'api-key' })).toEqual([
      'OPENAI_API_KEY',
    ]);
    expect(runnerAuthEnvKeys({ kind: 'cli', tool: 'copilot', authChannel: 'session' })).toEqual([
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ]);
  });

  it('keeps billing attached to the selected auth channel', () => {
    expect(
      resolveCliRunnerAuth({ kind: 'cli', tool: 'codex', authChannel: 'session' }).billing,
    ).toBe('subscription-included');
    expect(
      resolveCliRunnerAuth({ kind: 'cli', tool: 'codex', authChannel: 'api-key' }).billing,
    ).toBe('api-metered');
  });

  it('forwards no metered API key unless its channel is selected', async () => {
    const projectDir = createTempDir('sandbox-env-cli-auth-channel');
    dirs.push(projectDir);
    setEnv('OPENAI_API_KEY', 'sk-openai');

    const implicit = await createSandboxEnv({ projectDir });
    const session = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );
    const apiKey = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      'implementer',
    );

    expect(implicit.OPENAI_API_KEY).toBeUndefined();
    expect(session.OPENAI_API_KEY).toBeUndefined();
    expect(apiKey.OPENAI_API_KEY).toBe('sk-openai');
  });

  itUnix('clears a previous session bridge before selecting the API-key channel', async () => {
    const hostHome = createTempDir('sandbox-channel-reset-host');
    const projectDir = createTempDir('sandbox-channel-reset-project');
    dirs.push(hostHome, projectDir);
    const sessionToken = 'session-channel-reset-canary';
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), JSON.stringify({ token: sessionToken }));
    setEnv('HOME', hostHome);
    setEnv('OPENAI_API_KEY', 'api-channel-reset-canary');

    // One role, one root: the clear under test only has something to clear when
    // both acquisitions share a destination. Two roles would pass vacuously.
    const session = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );
    expect(existsSync(join(session.HOME as string, '.codex', 'auth.json'))).toBe(true);

    const apiKey = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      'implementer',
    );

    expect(existsSync(join(apiKey.HOME as string, '.codex', 'auth.json'))).toBe(false);
    expect(apiKey.OPENAI_API_KEY).toBe('api-channel-reset-canary');
    expect(JSON.stringify(apiKey)).not.toContain(sessionToken);
  });

  itUnix("leaves another runner's bridged snapshot in place while bridging its own", async () => {
    const hostHome = createTempDir('sandbox-shared-runners-host');
    const projectDir = createTempDir('sandbox-shared-runners-project');
    dirs.push(hostHome, projectDir);
    const codexState = '{"token":"codex-shared-sandbox-canary"}';
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), codexState);
    writeFileSync(
      join(hostHome, '.claude', '.credentials.json'),
      '{"token":"claude-shared-sandbox-canary"}',
    );
    setEnv('HOME', hostHome);

    // Two runners of one role on different tools — the shape a role's root is
    // meant to serve. Naming different roles would separate the destinations and
    // stop exercising the per-tool clear altogether.
    const codexEnv = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );
    const codexAuth = join(codexEnv.HOME as string, '.codex', 'auth.json');
    expect(existsSync(codexAuth)).toBe(true);

    const claudeEnv = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
      'implementer',
    );

    expect(existsSync(join(claudeEnv.HOME as string, '.claude', '.credentials.json'))).toBe(true);
    expect(readFileSync(codexAuth, 'utf8')).toBe(codexState);
  });

  itUnix("drops its own stale snapshot for an API-key channel and no other tool's", async () => {
    const hostHome = createTempDir('sandbox-shared-api-key-host');
    const projectDir = createTempDir('sandbox-shared-api-key-project');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"token":"codex-api-key-neighbour"}');
    writeFileSync(
      join(hostHome, '.claude', '.credentials.json'),
      '{"token":"claude-api-key-neighbour"}',
    );
    setEnv('HOME', hostHome);
    setEnv('OPENAI_API_KEY', 'sk-openai-neighbour');

    const claudeEnv = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
      'implementer',
    );
    await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );
    const apiKey = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      'implementer',
    );

    expect(existsSync(join(apiKey.HOME as string, '.codex', 'auth.json'))).toBe(false);
    expect(apiKey.OPENAI_API_KEY).toBe('sk-openai-neighbour');
    expect(existsSync(join(claudeEnv.HOME as string, '.claude', '.credentials.json'))).toBe(true);
  });

  // The reverse order of the case above, for two runners of one role — two
  // implementer profiles naming one tool on different auth channels. One
  // destination still cannot serve two channels of one tool; separating those
  // needs a profile-level identity in the path, which a role root does not
  // carry. The cross-role case is the role-scoped one below.
  itUnix(
    "leaves a same-tool session snapshot bridged after it in the API-key runner's own HOME",
    async () => {
      const hostHome = createTempDir('sandbox-channel-order-host');
      const projectDir = createTempDir('sandbox-channel-order-project');
      dirs.push(hostHome, projectDir);
      const sessionState = '{"token":"codex-channel-order-canary"}';
      mkdirSync(join(hostHome, '.codex'), { recursive: true });
      writeFileSync(join(hostHome, '.codex', 'auth.json'), sessionState);
      setEnv('HOME', hostHome);
      setEnv('OPENAI_API_KEY', 'sk-openai-channel-order');

      const apiKey = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
        'implementer',
      );
      const bridgedAuth = join(apiKey.HOME as string, '.codex', 'auth.json');
      expect(existsSync(bridgedAuth)).toBe(false);

      const session = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'codex', authChannel: 'session' },
        'implementer',
      );

      expect(session.HOME).toBe(apiKey.HOME);
      expect(readFileSync(bridgedAuth, 'utf8')).toBe(sessionState);
      // The api-key env carries no redaction value for a credential its child can
      // now read, so that runner's transcript would not redact the session token.
      expect(sandboxCredentialValues(apiKey)).toEqual([]);
    },
  );

  itUnix('gives each role its own sandbox root, in either acquisition order', async () => {
    const hostHome = createTempDir('sandbox-role-root-host');
    const sessionFirst = createTempDir('sandbox-role-root-session-first');
    const apiKeyFirst = createTempDir('sandbox-role-root-api-key-first');
    dirs.push(hostHome, sessionFirst, apiKeyFirst);
    const sessionState = '{"token":"codex-role-root-canary"}';
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), sessionState);
    setEnv('HOME', hostHome);
    setEnv('OPENAI_API_KEY', 'sk-openai-role-root');
    const session = { kind: 'cli', tool: 'codex', authChannel: 'session' } as const;
    const apiKey = { kind: 'cli', tool: 'codex', authChannel: 'api-key' } as const;

    const implementer = await createRunnerSandboxEnv(sessionFirst, session, 'implementer');
    const planner = await createRunnerSandboxEnv(sessionFirst, apiKey, 'planner');

    expect(readFileSync(join(implementer.HOME as string, '.codex', 'auth.json'), 'utf8')).toBe(
      sessionState,
    );
    expect(planner.HOME).not.toBe(implementer.HOME);
    expect(existsSync(join(planner.HOME as string, '.codex', 'auth.json'))).toBe(false);
    expect(planner.OPENAI_API_KEY).toBe('sk-openai-role-root');

    const reversedPlanner = await createRunnerSandboxEnv(apiKeyFirst, apiKey, 'planner');
    const reversedImplementer = await createRunnerSandboxEnv(apiKeyFirst, session, 'implementer');

    expect(existsSync(join(reversedPlanner.HOME as string, '.codex', 'auth.json'))).toBe(false);
    expect(
      readFileSync(join(reversedImplementer.HOME as string, '.codex', 'auth.json'), 'utf8'),
    ).toBe(sessionState);
  });

  it('bridges host CLI state only for an explicit session channel', async () => {
    const hostHome = createTempDir('sandbox-host-cli-state');
    const projectDir = createTempDir('sandbox-auth-state-bridge');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"account":"selected"}');
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"account":"unrelated"}');
    setEnv('HOME', hostHome);
    setEnv('OPENAI_API_KEY', 'sk-openai');

    const session = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );

    expect(session.HOME).toBe(join(projectDir, SANDBOX_DIR, 'implementer', 'codex', 'home'));
    expect(session.USERPROFILE).toBe(join(projectDir, SANDBOX_DIR, 'implementer', 'codex', 'home'));
    expect(session.XDG_CONFIG_HOME).toBe(
      join(projectDir, SANDBOX_DIR, 'implementer', 'codex', 'config'),
    );
    expect(session.APPDATA).toBe(join(projectDir, SANDBOX_DIR, 'implementer', 'codex', 'config'));
    expect(readFileSync(join(session.HOME as string, '.codex', 'auth.json'), 'utf8')).toBe(
      '{"account":"selected"}',
    );
    expect(existsSync(join(session.HOME as string, '.claude'))).toBe(false);
    expect(Object.values(session)).not.toContain(hostHome);
    expect(session.OPENAI_API_KEY).toBeUndefined();

    const apiKey = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      'implementer',
    );

    expect(apiKey.HOME).toBe(join(projectDir, SANDBOX_DIR, 'implementer', 'codex', 'home'));
    expect(apiKey.OPENAI_API_KEY).toBe('sk-openai');
  });

  it('keeps bridged state credential values only in non-enumerable parent redaction metadata', async () => {
    const hostHome = createTempDir('sandbox-state-redaction-host');
    const projectDir = createTempDir('sandbox-state-redaction-project');
    dirs.push(hostHome, projectDir);
    const credential = 'bridged-state-redaction-canary-4f9d';
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), JSON.stringify({ token: credential }));
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );

    expect(sandboxCredentialValues(env)).toContain(credential);
    expect(Object.keys(env)).not.toContain(credential);
    expect(Object.values(env)).not.toContain(credential);
    expect(JSON.stringify(env)).not.toContain(credential);
  });

  itUnix(
    'copies only selected static provider state once and seals the snapshot files',
    async () => {
      const hostHome = createTempDir('sandbox-state-host');
      const projectDir = createTempDir('sandbox-state-copy');
      const escapeTarget = createTempDir('sandbox-state-escape');
      dirs.push(hostHome, projectDir, escapeTarget);
      mkdirSync(join(hostHome, '.copilot'), { recursive: true });
      writeFileSync(join(hostHome, '.copilot', 'config.json'), 'before-change');
      writeFileSync(join(hostHome, '.copilot', 'unrelated.json'), 'not-admitted');
      writeFileSync(join(escapeTarget, 'secret.json'), 'outside-state');
      symlinkSync(escapeTarget, join(hostHome, '.copilot', 'escape'));
      setEnv('HOME', hostHome);

      const env = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'copilot', authChannel: 'session' },
        'implementer',
      );
      const bridgedConfig = join(env.HOME as string, '.copilot', 'config.json');

      expect(readFileSync(bridgedConfig, 'utf8')).toBe('before-change');
      expect(existsSync(join(env.HOME as string, '.copilot', 'unrelated.json'))).toBe(false);
      expect(existsSync(join(env.HOME as string, '.copilot', 'escape'))).toBe(false);
      expect(statSync(bridgedConfig).mode & 0o777).toBe(0o400);
      expect(statSync(join(env.HOME as string, '.copilot')).mode & 0o777).toBe(0o700);
      expect(() => writeFileSync(bridgedConfig, 'runner-mutation')).toThrow();

      writeFileSync(join(hostHome, '.copilot', 'config.json'), 'after-change');
      expect(readFileSync(bridgedConfig, 'utf8')).toBe('before-change');
      expect(readFileSync(join(hostHome, '.copilot', 'config.json'), 'utf8')).toBe('after-change');
    },
  );

  itUnix('passes a rotating credential through as a live state-directory link', async () => {
    const hostHome = createTempDir('sandbox-state-passthrough-host');
    const projectDir = createTempDir('sandbox-state-passthrough-project');
    dirs.push(hostHome, projectDir);
    const hostAuth = join(hostHome, '.codex', 'auth.json');
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(hostAuth, '{"tokens":{"refresh_token":"rotating-passthrough-canary-2c7e"}}');
    writeFileSync(join(hostHome, '.codex', 'config.toml'), 'model = "gpt-5"');
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );
    const linkDir = join(env.HOME as string, '.codex');

    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkDir)).toBe(realpathSync(join(hostHome, '.codex')));
    expect(readFileSync(join(linkDir, 'auth.json'), 'utf8')).toBe(
      '{"tokens":{"refresh_token":"rotating-passthrough-canary-2c7e"}}',
    );
    // The whole state directory is shared — that is the documented trade for a
    // credential the tool must be able to rewrite
    // (docs/PLANNERS-AND-IMPLEMENTERS.md, "Credential channels").
    expect(readFileSync(join(linkDir, 'config.toml'), 'utf8')).toBe('model = "gpt-5"');
    expect(sandboxCredentialValues(env)).toContain('rotating-passthrough-canary-2c7e');
  });

  itUnix(
    'a symlinked host state directory bridges successfully; a non-directory target still fails closed',
    async () => {
      const hostHome = createTempDir('sandbox-state-symlinked-host');
      const realState = createTempDir('sandbox-state-symlinked-real');
      const projectDir = createTempDir('sandbox-state-symlinked-project');
      const fileTarget = createTempDir('sandbox-state-symlinked-file');
      dirs.push(hostHome, realState, projectDir, fileTarget);
      const hostAuth = join(realState, 'auth.json');
      mkdirSync(realState, { recursive: true });
      writeFileSync(hostAuth, '{"token":"symlinked-passthrough-canary-8b1a"}');
      symlinkSync(realState, join(hostHome, '.codex'), 'dir');
      setEnv('HOME', hostHome);

      const env = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'codex', authChannel: 'session' },
        'implementer',
      );
      const linkDir = join(env.HOME as string, '.codex');

      expect(lstatSync(linkDir).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkDir)).toBe(realpathSync(realState));
      expect(readFileSync(join(linkDir, 'auth.json'), 'utf8')).toBe(
        '{"token":"symlinked-passthrough-canary-8b1a"}',
      );

      const badHome = createTempDir('sandbox-state-symlinked-bad-host');
      const badProject = createTempDir('sandbox-state-symlinked-bad-project');
      dirs.push(badHome, badProject);
      writeFileSync(join(fileTarget, 'not-a-directory'), 'not-a-dir');
      symlinkSync(join(fileTarget, 'not-a-directory'), join(badHome, '.codex'));
      setEnv('HOME', badHome);

      await expect(
        createRunnerSandboxEnv(
          badProject,
          { kind: 'cli', tool: 'codex', authChannel: 'session' },
          'implementer',
        ),
      ).rejects.toThrow(/Unable to create an isolated session state bridge/u);
    },
  );

  itUnix(
    "two implementer profiles on different tools receive distinct sandbox roots; neither HOME contains the other tool's state entry",
    async () => {
      const hostHome = createTempDir('sandbox-tool-root-host');
      const projectDir = createTempDir('sandbox-tool-root-project');
      dirs.push(hostHome, projectDir);
      mkdirSync(join(hostHome, '.codex'), { recursive: true });
      mkdirSync(join(hostHome, '.copilot'), { recursive: true });
      writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"token":"codex-tool-root-canary"}');
      writeFileSync(
        join(hostHome, '.copilot', 'config.json'),
        '{"token":"copilot-tool-root-canary"}',
      );
      setEnv('HOME', hostHome);

      const codexEnv = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'codex', authChannel: 'session' },
        'implementer',
      );
      const copilotEnv = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'copilot', authChannel: 'session' },
        'implementer',
      );

      expect(codexEnv.HOME).toBe(join(projectDir, SANDBOX_DIR, 'implementer', 'codex', 'home'));
      expect(copilotEnv.HOME).toBe(join(projectDir, SANDBOX_DIR, 'implementer', 'copilot', 'home'));
      expect(codexEnv.HOME).not.toBe(copilotEnv.HOME);
      expect(existsSync(join(codexEnv.HOME as string, '.codex', 'auth.json'))).toBe(true);
      expect(existsSync(join(codexEnv.HOME as string, '.copilot'))).toBe(false);
      expect(existsSync(join(copilotEnv.HOME as string, '.copilot', 'config.json'))).toBe(true);
      expect(existsSync(join(copilotEnv.HOME as string, '.codex'))).toBe(false);
    },
  );

  itUnix(
    'a rotation persisted through the sandbox survives teardown in the host file',
    async () => {
      const hostHome = createTempDir('sandbox-state-rotation-host');
      const projectDir = createTempDir('sandbox-state-rotation-project');
      dirs.push(hostHome, projectDir);
      const hostAuth = join(hostHome, '.codex', 'auth.json');
      mkdirSync(join(hostHome, '.codex'), { recursive: true });
      writeFileSync(hostAuth, '{"token":"pre-rotation"}');
      setEnv('HOME', hostHome);

      const env = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'codex', authChannel: 'session' },
        'implementer',
      );
      const sandboxAuth = join(env.HOME as string, '.codex', 'auth.json');

      // In-place rewrite — codex's current persistence strategy (its EACCES
      // against the old 0o400 snapshot proved an open-for-write, os error 13).
      writeFileSync(sandboxAuth, '{"token":"rotated-in-place"}');
      expect(readFileSync(hostAuth, 'utf8')).toBe('{"token":"rotated-in-place"}');

      // Tempfile-and-rename inside the state dir — the other strategy a vendor
      // can switch to without notice. A directory link survives both.
      const temp = join(env.HOME as string, '.codex', 'auth.json.tmp');
      writeFileSync(temp, '{"token":"rotated-by-rename"}');
      renameSync(temp, sandboxAuth);
      expect(readFileSync(hostAuth, 'utf8')).toBe('{"token":"rotated-by-rename"}');

      await clearBridgedCliState(projectDir);
      expect(existsSync(join(env.HOME as string, '.codex'))).toBe(false);
      expect(readFileSync(hostAuth, 'utf8')).toBe('{"token":"rotated-by-rename"}');

      rmSync(join(projectDir, SANDBOX_DIR), { recursive: true, force: true });
      expect(readFileSync(hostAuth, 'utf8')).toBe('{"token":"rotated-by-rename"}');
    },
  );

  itUnix(
    'a fresh acquisition reads rotated host state live and re-collects redaction',
    async () => {
      const hostHome = createTempDir('sandbox-state-live-host');
      const projectDir = createTempDir('sandbox-state-live-project');
      dirs.push(hostHome, projectDir);
      const hostAuth = join(hostHome, '.codex', 'auth.json');
      mkdirSync(join(hostHome, '.codex'), { recursive: true });
      const rotatedFrom = 'session-token-rotated-from';
      const rotatedTo = 'session-token-rotated-to';
      writeFileSync(hostAuth, JSON.stringify({ token: rotatedFrom }));
      setEnv('HOME', hostHome);
      const runner = { kind: 'cli', tool: 'codex', authChannel: 'session' } as const;

      const first = await createRunnerSandboxEnv(projectDir, runner, 'implementer');
      const bridgedAuth = join(first.HOME as string, '.codex', 'auth.json');
      expect(readFileSync(bridgedAuth, 'utf8')).toBe(JSON.stringify({ token: rotatedFrom }));

      // A host-side re-login is visible immediately — there is no snapshot to
      // go stale between acquisitions.
      writeFileSync(hostAuth, JSON.stringify({ token: rotatedTo }));
      expect(readFileSync(bridgedAuth, 'utf8')).toBe(JSON.stringify({ token: rotatedTo }));

      const second = await createRunnerSandboxEnv(projectDir, runner, 'implementer');
      expect(sandboxCredentialValues(second)).toContain(rotatedTo);
      expect(sandboxCredentialValues(second)).not.toContain(rotatedFrom);
    },
  );

  itUnix('replaces a stale sealed snapshot directory with the passthrough link', async () => {
    const hostHome = createTempDir('sandbox-state-stale-copy-host');
    const projectDir = createTempDir('sandbox-state-stale-copy-project');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"token":"live-host-token"}');
    setEnv('HOME', hostHome);
    // A sealed copy left behind by the previous bridge implementation.
    const sandboxHome = join(projectDir, SANDBOX_DIR, 'implementer', 'codex', 'home');
    mkdirSync(join(sandboxHome, '.codex'), { recursive: true, mode: 0o700 });
    writeFileSync(join(sandboxHome, '.codex', 'auth.json'), '{"token":"stale-snapshot"}', {
      mode: 0o400,
    });

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );

    expect(lstatSync(join(env.HOME as string, '.codex')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(env.HOME as string, '.codex', 'auth.json'), 'utf8')).toBe(
      '{"token":"live-host-token"}',
    );
  });

  itUnix(
    'never deletes host state through a child-planted symlink at a static state dir',
    async () => {
      const hostHome = createTempDir('sandbox-state-planted-host');
      const projectDir = createTempDir('sandbox-state-planted-project');
      dirs.push(hostHome, projectDir);
      const hostCredential = join(hostHome, '.claude', '.credentials.json');
      mkdirSync(join(hostHome, '.claude'), { recursive: true });
      writeFileSync(hostCredential, '{"session":"host-login"}');
      setEnv('HOME', hostHome);

      const env = await createSandboxEnv({
        projectDir,
        selectedCli: 'claude-code',
        hostState: 'bridged-files',
      });
      // A child replaces its sandbox copy dir with a symlink into the real HOME.
      rmSync(join(env.HOME as string, '.claude'), { recursive: true, force: true });
      symlinkSync(join(hostHome, '.claude'), join(env.HOME as string, '.claude'));

      await clearBridgedCliState(projectDir);

      expect(readFileSync(hostCredential, 'utf8')).toBe('{"session":"host-login"}');
      expect(existsSync(join(env.HOME as string, '.claude'))).toBe(false);

      // Re-bridging afterwards must also refuse to write through a planted link.
      const again = await createSandboxEnv({
        projectDir,
        selectedCli: 'claude-code',
        hostState: 'bridged-files',
      });
      expect(readFileSync(join(again.HOME as string, '.claude', '.credentials.json'), 'utf8')).toBe(
        '{"session":"host-login"}',
      );
      expect(readFileSync(hostCredential, 'utf8')).toBe('{"session":"host-login"}');
    },
  );

  itUnix('collects only credential-shaped state values for parent-side redaction', async () => {
    const hostHome = createTempDir('sandbox-state-token-shape-host');
    const projectDir = createTempDir('sandbox-state-token-shape-project');
    dirs.push(hostHome, projectDir);
    const accessToken = 'sk-ant-oat01-bridged-session-canary-91ac';
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(
      join(hostHome, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken, subscriptionType: 'max', type: 'oauth' },
      }),
    );
    setEnv('HOME', hostHome);

    // The file bridge is asked for directly: on macOS this channel reads the
    // login keychain instead, and the value shapes under test are the ones a
    // bridged `.credentials.json` carries.
    const env = await createSandboxEnv({
      projectDir,
      selectedCli: 'claude-code',
      hostState: 'bridged-files',
      role: 'implementer',
    });
    const values = sandboxCredentialValues(env);
    const redact = createRunnerCallCredentialRedactor(values);

    expect(values).toContain(accessToken);
    expect(values).not.toContain('max');
    expect(values).not.toContain('oauth');
    expect(redact('Implement the maximum retry approach for this process')).toBe(
      'Implement the maximum retry approach for this process',
    );
    expect(redact(`authorization: Bearer ${accessToken}`)).toBe(
      'authorization: Bearer ***REDACTED***',
    );
  });

  itUnix('clears the bridged snapshot without disturbing the rest of the sandbox', async () => {
    const hostHome = createTempDir('sandbox-state-clear-host');
    const projectDir = createTempDir('sandbox-state-clear-project');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(
      join(hostHome, '.codex', 'auth.json'),
      JSON.stringify({ token: 'cleared-token' }),
    );
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex', authChannel: 'session' },
      'implementer',
    );
    const bridgedAuth = join(env.HOME as string, '.codex', 'auth.json');
    expect(existsSync(bridgedAuth)).toBe(true);

    await clearBridgedCliState(projectDir);

    expect(existsSync(bridgedAuth)).toBe(false);
    expect(existsSync(env.HOME as string)).toBe(true);
    expect(readFileSync(join(hostHome, '.codex', 'auth.json'), 'utf8')).toBe(
      JSON.stringify({ token: 'cleared-token' }),
    );
  });

  itUnix(
    'clears one named tool from the sandbox and leaves every other bridge standing',
    async () => {
      const hostHome = createTempDir('sandbox-state-clear-one-host');
      const projectDir = createTempDir('sandbox-state-clear-one-project');
      dirs.push(hostHome, projectDir);
      mkdirSync(join(hostHome, '.codex'), { recursive: true });
      mkdirSync(join(hostHome, '.copilot'), { recursive: true });
      writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"token":"codex-selective-clear"}');
      writeFileSync(
        join(hostHome, '.copilot', 'config.json'),
        '{"token":"copilot-selective-clear"}',
      );
      setEnv('HOME', hostHome);

      const codex = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'codex', authChannel: 'session' },
        'implementer',
      );
      const copilot = await createRunnerSandboxEnv(
        projectDir,
        { kind: 'cli', tool: 'copilot', authChannel: 'session' },
        'implementer',
      );
      const codexAuth = join(codex.HOME as string, '.codex', 'auth.json');
      const copilotAuth = join(copilot.HOME as string, '.copilot', 'config.json');

      await clearBridgedCliState(projectDir, 'codex');

      expect(existsSync(codexAuth)).toBe(false);
      expect(existsSync(copilotAuth)).toBe(true);

      await clearBridgedCliState(projectDir);

      expect(existsSync(copilotAuth)).toBe(false);
    },
  );

  itUnix('clears bridged snapshots from every role root, not only the unscoped one', async () => {
    const hostHome = createTempDir('sandbox-role-clear-host');
    const projectDir = createTempDir('sandbox-role-clear-project');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    mkdirSync(join(hostHome, '.copilot'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"token":"codex-role-clear"}');
    writeFileSync(join(hostHome, '.copilot', 'config.json'), '{"token":"copilot-role-clear"}');
    setEnv('HOME', hostHome);
    const codex = { kind: 'cli', tool: 'codex', authChannel: 'session' } as const;

    const planner = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'copilot', authChannel: 'session' },
      'planner',
    );
    const implementer = await createRunnerSandboxEnv(projectDir, codex, 'implementer');
    // No runner acquisition can reach the unscoped root any more — createRunnerSandboxEnv
    // requires a role — but a tree carrying one from an earlier build still has to be
    // swept, so teardown is asserted against a root only createSandboxEnv can write.
    const unscoped = await createSandboxEnv({ projectDir, selectedCli: 'codex' });
    const bridged = [
      join(planner.HOME as string, '.copilot', 'config.json'),
      join(implementer.HOME as string, '.codex', 'auth.json'),
      join(unscoped.HOME as string, '.codex', 'auth.json'),
    ];
    expect(bridged.map((path) => existsSync(path))).toEqual([true, true, true]);

    await clearBridgedCliState(projectDir);

    expect(bridged.map((path) => existsSync(path))).toEqual([false, false, false]);
  });

  it('fails closed to an isolated environment when no selected tool is supplied', async () => {
    const hostHome = createTempDir('sandbox-state-unselected-host');
    const projectDir = createTempDir('sandbox-state-unselected');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), 'not-bridged');
    setEnv('HOME', hostHome);

    const env = await createSandboxEnv({ projectDir });

    expect(env.HOME).toBe(join(projectDir, SANDBOX_DIR, 'home'));
    expect(existsSync(join(env.HOME as string, '.codex'))).toBe(false);
    expect(Object.values(env)).not.toContain(hostHome);
  });

  it('includes an explicit env: apiKey reference', () => {
    expect(
      runnerAuthEnvKeys({
        kind: 'api',
        provider: 'custom-provider',
        service: 'custom-provider',
        offering: 'payg',
        apiBase: 'https://example.com/v1',
        apiKey: 'env:CUSTOM_PROVIDER_KEY',
        model: 'm',
      }),
    ).toContain('CUSTOM_PROVIDER_KEY');
  });

  it('keeps a shell-only provider key for a provider-dependent tool and scrubs it for every other channel', () => {
    setEnv('FOO_API_KEY', 'shell-only');

    expect(runnerAuthEnvKeys({ kind: 'cli', tool: 'opencode' })).toContain('FOO_API_KEY');
    expect(runnerAuthEnvKeys({ kind: 'cli', tool: 'kilo-code' })).toContain('FOO_API_KEY');
    expect(runnerAuthEnvKeys({ kind: 'cli', tool: 'codex' })).not.toContain('FOO_API_KEY');

    unsetEnv('FOO_TOKEN');
    setEnv('FOO_TOKEN', 'shell-only');
    expect(runnerAuthEnvKeys({ kind: 'cli', tool: 'opencode' })).not.toContain('FOO_TOKEN');
  });

  it('carries a shell-only provider key into the dispatch env of a tool whose channel declares no env', async () => {
    const projectDir = createTempDir('sandbox-env-provider-passthrough');
    dirs.push(projectDir);
    setEnv('FOO_API_KEY', 'shell-only');

    const providerDependent = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'opencode' },
      'implementer',
    );
    const session = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'codex' },
      'implementer',
    );

    expect(providerDependent.FOO_API_KEY).toBe('shell-only');
    expect(session.FOO_API_KEY).toBeUndefined();
  });
});

describe('runnerSandboxIdentity', () => {
  it('separates runners whose sandbox differs and repeats for one that does not', () => {
    const codexSession = { kind: 'cli', tool: 'codex', authChannel: 'session' } as const;

    expect(runnerSandboxIdentity(codexSession)).toBe(runnerSandboxIdentity({ ...codexSession }));
    expect(runnerSandboxIdentity(codexSession)).not.toBe(
      runnerSandboxIdentity({ kind: 'cli', tool: 'codex', authChannel: 'api-key' }),
    );
    expect(runnerSandboxIdentity(codexSession)).not.toBe(
      runnerSandboxIdentity({ kind: 'cli', tool: 'claude-code', authChannel: 'session' }),
    );
  });

  it('never carries a literal apiKey', () => {
    const literalKey = 'sk-literal-identity-canary-4f9d';

    const identity = runnerSandboxIdentity({
      kind: 'api',
      provider: 'custom-provider',
      service: 'custom-provider',
      offering: 'payg',
      apiBase: 'https://example.com/v1',
      apiKey: literalKey,
      model: 'm',
    });

    expect(identity).not.toContain(literalKey);
  });
});

describe('backend compatibility fixtures', () => {
  itUnix('bridges the OpenCode state directory as a live passthrough link', async () => {
    const hostHome = createTempDir('sandbox-opencode-host');
    const projectDir = createTempDir('sandbox-opencode-project');
    dirs.push(hostHome, projectDir);
    const token = 'opencode-session-compat-canary-7e3a';
    mkdirSync(join(hostHome, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(hostHome, '.config', 'opencode', 'auth.json'), JSON.stringify({ token }));
    writeFileSync(join(hostHome, '.config', 'opencode', 'opencode.json'), '{"dangerous":true}');
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'opencode', authChannel: 'provider-dependent' },
      'planner',
    );

    const linkDir = join(env.XDG_CONFIG_HOME as string, 'opencode');
    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkDir)).toBe(realpathSync(join(hostHome, '.config', 'opencode')));
    expect(readFileSync(join(linkDir, 'auth.json'), 'utf8')).toBe(JSON.stringify({ token }));
    expect(sandboxCredentialValues(env)).toContain(token);
  });

  itUnix(
    'a bridged cursor env exposes exactly the two declared paths and nothing else from ~/.cursor',
    async () => {
      const hostHome = createTempDir('sandbox-cursor-host');
      const projectDir = createTempDir('sandbox-cursor-project');
      dirs.push(hostHome, projectDir);
      const agentStateToken = 'cursor-agent-state-canary-9f1b';
      const hostCliConfig = JSON.stringify({
        approvalMode: 'unrestricted',
        sandbox: { mode: 'disabled' },
      });
      mkdirSync(join(hostHome, '.cursor'), { recursive: true });
      writeFileSync(join(hostHome, '.cursor', 'cli-config.json'), hostCliConfig);
      writeFileSync(
        join(hostHome, '.cursor', 'agent-cli-state.json'),
        JSON.stringify({ token: agentStateToken }),
      );
      writeFileSync(join(hostHome, '.cursor', 'unrelated.json'), '{"not":"admitted"}');
      setEnv('HOME', hostHome);

      // The file bridge is asked for directly: on macOS this channel is
      // host-account, and the two-path isolation under test is the
      // bridged-files contract.
      const env = await createSandboxEnv({
        projectDir,
        selectedCli: 'cursor',
        hostState: 'bridged-files',
        role: 'planner',
      });

      const sandboxCursor = join(env.HOME as string, '.cursor');
      const hostCursor = join(hostHome, '.cursor');
      const childCliConfigPath = join(sandboxCursor, 'cli-config.json');
      const childCliConfig = readFileSync(childCliConfigPath, 'utf8');
      expect(lstatSync(sandboxCursor).isSymbolicLink()).toBe(false);
      expect(lstatSync(childCliConfigPath).isSymbolicLink()).toBe(false);
      expect(childCliConfig).not.toBe(hostCliConfig);
      expect(childCliConfig).not.toContain('"approvalMode":"unrestricted"');
      expect(JSON.parse(childCliConfig)).toEqual(
        expect.objectContaining({
          approvalMode: 'allowlist',
          sandbox: { mode: 'enabled' },
        }),
      );
      expect(readFileSync(join(sandboxCursor, 'agent-cli-state.json'), 'utf8')).toBe(
        JSON.stringify({ token: agentStateToken }),
      );
      expect(readdirSync(sandboxCursor).toSorted()).toEqual([
        'agent-cli-state.json',
        'cli-config.json',
      ]);
      expect(existsSync(join(sandboxCursor, 'unrelated.json'))).toBe(false);
      expect(await bridgedCliStatePresent(env, 'cursor')).toBe(true);
      writeFileSync(
        join(sandboxCursor, 'cli-config.json'),
        JSON.stringify({ token: 'rotated-cli' }),
      );
      writeFileSync(
        join(sandboxCursor, 'agent-cli-state.json'),
        JSON.stringify({ token: 'rotated-agent' }),
      );
      expect(readFileSync(join(hostCursor, 'cli-config.json'), 'utf8')).toBe(hostCliConfig);
      expect(readFileSync(join(hostCursor, 'agent-cli-state.json'), 'utf8')).toBe(
        JSON.stringify({ token: 'rotated-agent' }),
      );
      expect(readFileSync(join(hostCursor, 'unrelated.json'), 'utf8')).toBe('{"not":"admitted"}');
      expect(sandboxCredentialValues(env)).toContain(agentStateToken);
      expect(sandboxCredentialValues(env)).not.toContain('unrestricted');
    },
  );

  itUnix('bridges the Kilo auth entries as live passthrough links', async () => {
    const hostHome = createTempDir('sandbox-kilo-host');
    const projectDir = createTempDir('sandbox-kilo-project');
    dirs.push(hostHome, projectDir);
    const kiloToken = 'kilo-session-compat-canary-1f2b';
    const kilocodeToken = 'kilocode-session-compat-canary-3c4d';
    mkdirSync(join(hostHome, '.config', 'kilo'), { recursive: true });
    mkdirSync(join(hostHome, '.config', 'kilocode'), { recursive: true });
    writeFileSync(join(hostHome, '.config', 'kilo', 'auth.json'), JSON.stringify({ kiloToken }));
    writeFileSync(
      join(hostHome, '.config', 'kilocode', 'auth.json'),
      JSON.stringify({ kilocodeToken }),
    );
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'kilo-code', authChannel: 'provider-dependent' },
      'planner',
    );

    const kiloLink = join(env.XDG_CONFIG_HOME as string, 'kilo');
    const kilocodeLink = join(env.XDG_CONFIG_HOME as string, 'kilocode');
    expect(readlinkSync(kiloLink)).toBe(realpathSync(join(hostHome, '.config', 'kilo')));
    expect(readlinkSync(kilocodeLink)).toBe(realpathSync(join(hostHome, '.config', 'kilocode')));
    expect(readFileSync(join(kiloLink, 'auth.json'), 'utf8')).toBe(JSON.stringify({ kiloToken }));
    expect(readFileSync(join(kilocodeLink, 'auth.json'), 'utf8')).toBe(
      JSON.stringify({ kilocodeToken }),
    );
    expect(sandboxCredentialValues(env)).toEqual(
      expect.arrayContaining([kiloToken, kilocodeToken]),
    );
  });

  itUnix('seals the command-code auth snapshot and exposes no ambient env credential', async () => {
    const hostHome = createTempDir('sandbox-command-code-host');
    const projectDir = createTempDir('sandbox-command-code-project');
    dirs.push(hostHome, projectDir);
    // The state directory is `.commandcode`, unhyphenated, unlike the tool id.
    const credential = JSON.stringify({ apiKey: 'command-code-session-canary-5a8e' });
    const hostAuth = join(hostHome, '.commandcode', 'auth.json');
    mkdirSync(join(hostHome, '.commandcode'), { recursive: true });
    writeFileSync(hostAuth, credential);
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'command-code', authChannel: 'session' },
      'planner',
    );

    expect(env.HOME).toBe(join(projectDir, SANDBOX_DIR, 'planner', 'command-code', 'home'));
    expect(await bridgedCliStatePresent(env, 'command-code')).toBe(true);

    // The login mints a long-lived apiKey that never rotates, so the child
    // reads a sealed copy and the host file stays out of its reach.
    const sealed = join(env.HOME as string, '.commandcode', 'auth.json');
    expect(lstatSync(sealed).isSymbolicLink()).toBe(false);
    expect(readFileSync(sealed, 'utf8')).toBe(credential);
    expect(statSync(sealed).mode & 0o777).toBe(0o400);

    expect(Object.keys(env).filter((key) => /COMMAND.?CODE|^CMD_/iu.test(key))).toEqual([]);
  });

  it('declares no env credential on the OpenCode and Kilo provider-dependent channels', () => {
    expect(resolveCliRunnerAuth({ kind: 'cli', tool: 'opencode' }).id).toBe('provider-dependent');
    expect(resolveCliRunnerAuth({ kind: 'cli', tool: 'kilo-code' }).id).toBe('provider-dependent');
    // The channel declares no credential of its own. What a dispatch env then
    // carries is the shell's own provider keys, which `cliAuthChannelEnvKeys`
    // covers; asserting on `runnerAuthEnvKeys` here would only re-read the
    // machine's environment.
    expect(
      resolveCliRunnerAuth({ kind: 'cli', tool: 'opencode', authChannel: 'provider-dependent' })
        .env,
    ).toEqual([]);
    expect(
      resolveCliRunnerAuth({ kind: 'cli', tool: 'kilo-code', authChannel: 'provider-dependent' })
        .env,
    ).toEqual([]);
    expect(resolveCliRunnerAuth({ kind: 'cli', tool: 'opencode' }).billing).toBe(
      'provider-dependent',
    );
    expect(resolveCliRunnerAuth({ kind: 'cli', tool: 'kilo-code' }).billing).toBe(
      'provider-dependent',
    );
  });

  it('preserves ANTHROPIC_API_KEY for a Claude api-key runner and stages no state', async () => {
    const hostHome = createTempDir('sandbox-claude-api-host');
    const projectDir = createTempDir('sandbox-claude-api-project');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"token":"host-session"}');
    setEnv('HOME', hostHome);
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-compat-canary');

    const env = await createRunnerSandboxEnv(
      projectDir,
      { kind: 'cli', tool: 'claude-code', authChannel: 'api-key' },
      'planner',
    );

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-compat-canary');
    expect(env.HOME).toBe(join(projectDir, SANDBOX_DIR, 'planner', 'claude-code', 'home'));
    expect(existsSync(join(env.HOME as string, '.claude'))).toBe(false);
    expect(sandboxCredentialValues(env)).toEqual([]);
  });
});

describe('concurrent sandbox acquisition', () => {
  itUnix(
    'serializes two concurrent acquisitions of one root; both succeed and each child reads the credential',
    async () => {
      const hostHome = createTempDir('sandbox-concurrent-host');
      const projectDir = createTempDir('sandbox-concurrent-project');
      dirs.push(hostHome, projectDir);
      const credential = JSON.stringify({ token: 'concurrent-acquisition-canary-4f9d' });
      mkdirSync(join(hostHome, '.copilot'), { recursive: true });
      writeFileSync(join(hostHome, '.copilot', 'config.json'), credential);
      setEnv('HOME', hostHome);
      const runner = { kind: 'cli', tool: 'copilot', authChannel: 'session' } as const;

      const [first, second] = await Promise.all([
        createRunnerSandboxEnv(projectDir, runner, 'implementer'),
        createRunnerSandboxEnv(projectDir, runner, 'implementer'),
      ]);

      expect(first.HOME).toBe(second.HOME);
      for (const env of [first, second]) {
        expect(await bridgedCliStatePresent(env, 'copilot')).toBe(true);
        const child = spawnSync(
          process.execPath,
          [
            '-e',
            "const fs=require('node:fs');const p=require('node:path');process.stdout.write(fs.readFileSync(p.join(process.env.HOME,'.copilot','config.json'),'utf8'))",
          ],
          { env },
        );
        expect(child.status).toBe(0);
        expect(child.stdout.toString('utf8')).toBe(credential);
      }
      const sealed = join(first.HOME as string, '.copilot', 'config.json');
      expect(readFileSync(sealed, 'utf8')).toBe(credential);
      expect(statSync(sealed).mode & 0o777).toBe(0o400);
    },
  );
});

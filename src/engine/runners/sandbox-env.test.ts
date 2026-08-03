import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import {
  clearBridgedCliState,
  createRunnerSandboxEnv,
  createSandboxEnv,
  prependCliExecutableDirectory,
  resolveCliRunnerAuth,
  runnerAuthEnvKeys,
  sandboxCredentialValues,
} from './sandbox-env.js';
import { createRunnerCallCredentialRedactor } from '../calls/status.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];
const originalEnvValues = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!originalEnvValues.has(key)) originalEnvValues.set(key, process.env[key]);
  process.env[key] = value;
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

describe('createSandboxEnv', () => {
  it('redirects HOME/XDG/cache env to fresh sandbox dirs', async () => {
    const projectDir = createTempDir('sandbox-env');
    dirs.push(projectDir);

    const env = await createSandboxEnv(projectDir);

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
    mkdirSync(join(fakeHome, '.aider'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', '.credentials.json'), '{"token":"secret"}');

    setEnv('HOME', fakeHome);

    const env = await createSandboxEnv(projectDir);

    const sandboxHome = env.HOME as string;
    expect(existsSync(join(sandboxHome, '.claude'))).toBe(false);
    expect(existsSync(join(sandboxHome, '.codex'))).toBe(false);
    expect(existsSync(join(sandboxHome, '.aider'))).toBe(false);
  });

  itUnix('does not seed writable credential files into the sandbox HOME', async () => {
    const fakeHome = createTempDir('sandbox-real-home');
    const projectDir = createTempDir('sandbox-env-no-creds');
    dirs.push(fakeHome, projectDir);

    writeFileSync(join(fakeHome, '.npmrc'), '//registry/:_authToken=abc\n');
    writeFileSync(join(fakeHome, '.netrc'), 'machine example.com login user password pass\n');

    setEnv('HOME', fakeHome);

    const env = await createSandboxEnv(projectDir);

    const sandboxHome = env.HOME as string;
    expect(existsSync(join(sandboxHome, '.npmrc'))).toBe(false);
    expect(existsSync(join(sandboxHome, '.netrc'))).toBe(false);
  });

  itUnix('does not fail when the real HOME has no credential entries', async () => {
    const fakeHome = createTempDir('sandbox-empty-home');
    const projectDir = createTempDir('sandbox-env-empty');
    dirs.push(fakeHome, projectDir);
    setEnv('HOME', fakeHome);

    const env = await createSandboxEnv(projectDir);

    const sandboxHome = env.HOME as string;
    expect(existsSync(sandboxHome)).toBe(true);
    expect(existsSync(join(sandboxHome, '.claude'))).toBe(false);
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

    const env = await createSandboxEnv(projectDir);

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

    const env = await createSandboxEnv(projectDir, ['CUSTOM_TOKEN_FILE']);

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

    const env = await createSandboxEnv(projectDir, ['OPENAI_API_KEY']);

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

    const env = await createSandboxEnv(projectDir);

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

    const env = await createSandboxEnv(projectDir, ['NODE_OPTIONS', 'GIT_ASKPASS']);

    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
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

    const implicit = await createSandboxEnv(projectDir);
    const session = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });
    const apiKey = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'api-key',
    });

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

    const session = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });
    expect(existsSync(join(session.HOME as string, '.codex', 'auth.json'))).toBe(true);

    const apiKey = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'api-key',
    });

    expect(existsSync(join(apiKey.HOME as string, '.codex', 'auth.json'))).toBe(false);
    expect(apiKey.OPENAI_API_KEY).toBe('api-channel-reset-canary');
    expect(JSON.stringify(apiKey)).not.toContain(sessionToken);
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

    const session = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });

    expect(session.HOME).toBe(join(projectDir, SANDBOX_DIR, 'home'));
    expect(session.USERPROFILE).toBe(join(projectDir, SANDBOX_DIR, 'home'));
    expect(session.XDG_CONFIG_HOME).toBe(join(projectDir, SANDBOX_DIR, 'config'));
    expect(session.APPDATA).toBe(join(projectDir, SANDBOX_DIR, 'config'));
    expect(readFileSync(join(session.HOME as string, '.codex', 'auth.json'), 'utf8')).toBe(
      '{"account":"selected"}',
    );
    expect(existsSync(join(session.HOME as string, '.claude'))).toBe(false);
    expect(Object.values(session)).not.toContain(hostHome);
    expect(session.OPENAI_API_KEY).toBeUndefined();

    const apiKey = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'api-key',
    });

    expect(apiKey.HOME).toBe(join(projectDir, SANDBOX_DIR, 'home'));
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

    const env = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });

    expect(sandboxCredentialValues(env)).toContain(credential);
    expect(Object.keys(env)).not.toContain(credential);
    expect(Object.values(env)).not.toContain(credential);
    expect(JSON.stringify(env)).not.toContain(credential);
  });

  itUnix('copies only selected provider state once and seals the snapshot files', async () => {
    const hostHome = createTempDir('sandbox-state-host');
    const projectDir = createTempDir('sandbox-state-copy');
    const escapeTarget = createTempDir('sandbox-state-escape');
    dirs.push(hostHome, projectDir, escapeTarget);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), 'before-change');
    writeFileSync(join(hostHome, '.codex', 'unrelated.json'), 'not-admitted');
    writeFileSync(join(escapeTarget, 'secret.json'), 'outside-state');
    symlinkSync(escapeTarget, join(hostHome, '.codex', 'escape'));
    setEnv('HOME', hostHome);

    const env = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });
    const bridgedAuth = join(env.HOME as string, '.codex', 'auth.json');

    expect(readFileSync(bridgedAuth, 'utf8')).toBe('before-change');
    expect(existsSync(join(env.HOME as string, '.codex', 'unrelated.json'))).toBe(false);
    expect(existsSync(join(env.HOME as string, '.codex', 'escape'))).toBe(false);
    expect(statSync(bridgedAuth).mode & 0o777).toBe(0o400);
    expect(statSync(join(env.HOME as string, '.codex')).mode & 0o777).toBe(0o700);
    expect(() => writeFileSync(bridgedAuth, 'runner-mutation')).toThrow();

    writeFileSync(join(hostHome, '.codex', 'auth.json'), 'after-change');
    expect(readFileSync(bridgedAuth, 'utf8')).toBe('before-change');
    expect(readFileSync(join(hostHome, '.codex', 'auth.json'), 'utf8')).toBe('after-change');
  });

  itUnix('re-bridges the snapshot after the host provider state is rotated', async () => {
    const hostHome = createTempDir('sandbox-state-rotation-host');
    const projectDir = createTempDir('sandbox-state-rotation-project');
    dirs.push(hostHome, projectDir);
    const hostAuth = join(hostHome, '.codex', 'auth.json');
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    const rotatedFrom = 'session-token-rotated-from';
    const rotatedTo = 'session-token-rotated-to';
    writeFileSync(hostAuth, JSON.stringify({ token: rotatedFrom }));
    setEnv('HOME', hostHome);
    const runner = { kind: 'cli', tool: 'codex', authChannel: 'session' } as const;

    const first = await createRunnerSandboxEnv(projectDir, runner);
    const bridgedAuth = join(first.HOME as string, '.codex', 'auth.json');
    expect(readFileSync(bridgedAuth, 'utf8')).toBe(JSON.stringify({ token: rotatedFrom }));

    writeFileSync(hostAuth, JSON.stringify({ token: rotatedTo }));
    const second = await createRunnerSandboxEnv(projectDir, runner);

    expect(readFileSync(bridgedAuth, 'utf8')).toBe(JSON.stringify({ token: rotatedTo }));
    expect(statSync(bridgedAuth).mode & 0o222).toBe(0);
    expect(sandboxCredentialValues(second)).toContain(rotatedTo);
    expect(sandboxCredentialValues(second)).not.toContain(rotatedFrom);
  });

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

    const env = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'claude-code',
      authChannel: 'session',
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

    const env = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'session',
    });
    const bridgedAuth = join(env.HOME as string, '.codex', 'auth.json');
    expect(existsSync(bridgedAuth)).toBe(true);

    await clearBridgedCliState(projectDir);

    expect(existsSync(bridgedAuth)).toBe(false);
    expect(existsSync(env.HOME as string)).toBe(true);
    expect(readFileSync(join(hostHome, '.codex', 'auth.json'), 'utf8')).toBe(
      JSON.stringify({ token: 'cleared-token' }),
    );
  });

  it('fails closed to an isolated environment when no selected tool is supplied', async () => {
    const hostHome = createTempDir('sandbox-state-unselected-host');
    const projectDir = createTempDir('sandbox-state-unselected');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), 'not-bridged');
    setEnv('HOME', hostHome);

    const env = await createSandboxEnv(projectDir, []);

    expect(env.HOME).toBe(join(projectDir, SANDBOX_DIR, 'home'));
    expect(existsSync(join(env.HOME as string, '.codex'))).toBe(false);
    expect(Object.values(env)).not.toContain(hostHome);
  });

  it('maps the agent-sdk runner to ANTHROPIC_API_KEY', () => {
    expect(runnerAuthEnvKeys({ kind: 'agent-sdk', model: 'auto' })).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('maps a known api provider to its catalog auth env var', () => {
    expect(
      runnerAuthEnvKeys({
        kind: 'api',
        provider: 'openai',
        service: 'openai',
        offering: 'payg',
        apiBase: 'https://api.openai.com/v1',
        model: 'gpt-4',
      }),
    ).toEqual(['OPENAI_API_KEY']);
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
});

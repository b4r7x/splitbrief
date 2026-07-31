import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
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
  createRunnerSandboxEnv,
  createSandboxEnv,
  resolveCliRunnerAuth,
  runnerAuthEnvKeys,
  sandboxCredentialValues,
} from './sandbox-env.js';
import { resolveCliExecutable } from './resolve-cli-executable.js';
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

function makeExecutable(path: string, body = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

describe('resolver identity and trust', () => {
  itUnix('resolver rejects a project-local PATH shadow instead of falling through', async () => {
    const projectDir = createTempDir('sandbox-resolver-project');
    const systemDir = createTempDir('sandbox-resolver-system');
    dirs.push(projectDir, systemDir);
    const projectBin = join(projectDir, 'bin');
    mkdirSync(projectBin);
    makeExecutable(join(projectBin, 'vendor-cli'));
    makeExecutable(join(systemDir, 'vendor-cli'));
    setEnv('PATH', [projectBin, systemDir].join(delimiter));

    await expect(resolveCliExecutable('vendor-cli', projectDir)).rejects.toMatchObject({
      kind: 'cli-executable-untrusted',
    });
  });

  itUnix('resolver rejects empty and relative PATH shadows', async () => {
    const projectDir = createTempDir('sandbox-resolver-relative');
    const relativeBin = join(projectDir, 'relative-bin');
    dirs.push(projectDir);
    mkdirSync(relativeBin);
    makeExecutable(join(relativeBin, 'vendor-cli'));

    setEnv('PATH', `relative-bin${delimiter}`);
    await expect(resolveCliExecutable('vendor-cli', projectDir)).rejects.toMatchObject({
      kind: 'cli-executable-untrusted',
    });
  });

  itUnix('identity uses the absolute real executable behind a symlink', async () => {
    const projectDir = createTempDir('sandbox-identity-project');
    const realBin = createTempDir('sandbox-identity-real');
    const linkBin = createTempDir('sandbox-identity-link');
    dirs.push(projectDir, realBin, linkBin);
    const executable = join(realBin, 'vendor-cli');
    makeExecutable(executable);
    symlinkSync(executable, join(linkBin, 'vendor-cli'));
    setEnv('PATH', linkBin);

    const identity = await resolveCliExecutable('vendor-cli', projectDir);

    expect(identity.path).toBe(realpathSync(executable));
    expect(identity.fingerprint).toMatchObject({
      size: expect.any(Number),
      mtimeMs: expect.any(Number),
    });
  });

  itUnix('identity drift fails closed before reuse', async () => {
    const projectDir = createTempDir('sandbox-identity-drift-project');
    const binDir = createTempDir('sandbox-identity-drift-bin');
    dirs.push(projectDir, binDir);
    const executable = join(binDir, 'vendor-cli');
    makeExecutable(executable);
    setEnv('PATH', binDir);
    const identity = await resolveCliExecutable('vendor-cli', projectDir);
    makeExecutable(executable, '#!/bin/sh\necho changed identity\n');

    await expect(resolveCliExecutable('vendor-cli', projectDir, identity)).rejects.toMatchObject({
      kind: 'cli-executable-identity-drift',
    });
  });

  itUnix('exact identity trust admits that project-local executable only', async () => {
    const trustedRoot = createTempDir('sandbox-identity-trust');
    const neutralProject = createTempDir('sandbox-identity-neutral');
    dirs.push(trustedRoot, neutralProject);
    const binDir = join(trustedRoot, 'bin');
    mkdirSync(binDir);
    makeExecutable(join(binDir, 'vendor-cli'));
    setEnv('PATH', binDir);
    const trust = await resolveCliExecutable('vendor-cli', neutralProject);

    await expect(resolveCliExecutable('vendor-cli', trustedRoot)).rejects.toMatchObject({
      kind: 'cli-executable-untrusted',
    });
    await expect(resolveCliExecutable('vendor-cli', trustedRoot, trust)).resolves.toEqual(trust);
  });

  itUnix('does not expose absolute paths in unavailable executable diagnostics', async () => {
    const projectDir = createTempDir('sandbox-diagnostic-unavailable');
    dirs.push(projectDir);
    const command = join(projectDir, 'private', 'missing-cli');

    let caught: unknown;
    try {
      await resolveCliExecutable(command, projectDir);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(Error);
    const failure = caught as Error & { data?: unknown };
    expect(failure.message).not.toContain(projectDir);
    expect(JSON.stringify(failure.data)).not.toContain(projectDir);
    expect(failure.message).toContain('missing-cli');
    expect(failure.data).toMatchObject({ command: 'missing-cli' });
  });

  itUnix('does not expose absolute paths in untrusted executable diagnostics', async () => {
    const projectDir = createTempDir('sandbox-diagnostic-untrusted');
    dirs.push(projectDir);
    const binDir = join(projectDir, 'private');
    mkdirSync(binDir);
    const command = join(binDir, 'shadow-cli');
    makeExecutable(command);

    let caught: unknown;
    try {
      await resolveCliExecutable(command, projectDir);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(Error);
    const failure = caught as Error & { data?: unknown };
    expect(failure.message).not.toContain(projectDir);
    expect(JSON.stringify(failure.data)).not.toContain(projectDir);
    expect(failure.message).toContain('shadow-cli');
    expect(failure.data).toMatchObject({
      command: 'shadow-cli',
      identity: { fingerprint: { size: expect.any(Number) } },
    });
  });

  itUnix('does not expose absolute paths while preserving drift fingerprints', async () => {
    const projectDir = createTempDir('sandbox-diagnostic-drift');
    dirs.push(projectDir);
    const binDir = createTempDir('sandbox-diagnostic-drift-bin');
    dirs.push(binDir);
    const command = join(binDir, 'drift-cli');
    makeExecutable(command);
    const trusted = await resolveCliExecutable(command, projectDir);
    makeExecutable(command, '#!/bin/sh\necho changed identity\n');

    let caught: unknown;
    try {
      await resolveCliExecutable(command, projectDir, trusted);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(Error);
    const failure = caught as Error & { data?: unknown };
    expect(failure.message).not.toContain(projectDir);
    expect(JSON.stringify(failure.data)).not.toContain(projectDir);
    expect(failure.message).toContain('drift-cli');
    expect(failure.data).toMatchObject({
      command: 'drift-cli',
      expectedIdentity: { fingerprint: trusted.fingerprint },
      actualIdentity: { fingerprint: expect.any(Object) },
    });
    expect((failure.data as { expectedIdentity: unknown }).expectedIdentity).not.toHaveProperty(
      'path',
    );
    expect((failure.data as { actualIdentity: unknown }).actualIdentity).not.toHaveProperty('path');
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
  it('fails closed instead of inferring a CLI auth channel from ambient credentials', () => {
    expect(() => runnerAuthEnvKeys({ kind: 'cli', tool: 'claude-code', model: 'auto' })).toThrow(
      /explicit authChannel/,
    );
    expect(() => runnerAuthEnvKeys({ kind: 'cli', tool: 'codex' })).toThrow(/explicit authChannel/);
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
    const apiKey = await createRunnerSandboxEnv(projectDir, {
      kind: 'cli',
      tool: 'codex',
      authChannel: 'api-key',
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
    expect(statSync(bridgedAuth).mode & 0o222).toBe(0);
    expect(() => writeFileSync(bridgedAuth, 'runner-mutation')).toThrow();

    writeFileSync(join(hostHome, '.codex', 'auth.json'), 'after-change');
    expect(readFileSync(bridgedAuth, 'utf8')).toBe('before-change');
    expect(readFileSync(join(hostHome, '.codex', 'auth.json'), 'utf8')).toBe('after-change');
  });

  it('fails closed to an isolated environment when no selected tool is supplied', async () => {
    const hostHome = createTempDir('sandbox-state-unselected-host');
    const projectDir = createTempDir('sandbox-state-unselected');
    dirs.push(hostHome, projectDir);
    mkdirSync(join(hostHome, '.codex'), { recursive: true });
    writeFileSync(join(hostHome, '.codex', 'auth.json'), 'not-bridged');
    setEnv('HOME', hostHome);

    const env = await createSandboxEnv(projectDir, [], true);

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

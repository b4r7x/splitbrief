import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import { createSandboxEnv, runnerAuthEnvKeys } from './sandbox-env.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];
let originalHome: string | undefined;
const touchedEnvKeys: string[] = [];

function setEnv(key: string, value: string): void {
  touchedEnvKeys.push(key);
  process.env[key] = value;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  originalHome = undefined;
  for (const key of touchedEnvKeys) delete process.env[key];
  touchedEnvKeys.length = 0;
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
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

    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

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

    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    const env = await createSandboxEnv(projectDir);

    const sandboxHome = env.HOME as string;
    expect(existsSync(join(sandboxHome, '.npmrc'))).toBe(false);
    expect(existsSync(join(sandboxHome, '.netrc'))).toBe(false);
  });

  itUnix('does not fail when the real HOME has no credential entries', async () => {
    const fakeHome = createTempDir('sandbox-empty-home');
    const projectDir = createTempDir('sandbox-env-empty');
    dirs.push(fakeHome, projectDir);
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    const env = await createSandboxEnv(projectDir);

    const sandboxHome = env.HOME as string;
    expect(existsSync(sandboxHome)).toBe(true);
    expect(existsSync(join(sandboxHome, '.claude'))).toBe(false);
  });

  it('strips ambient and unenumerated provider secrets from the sandbox env', async () => {
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
    expect(env.SPLITBRIEF_PUBLIC_FLAG).toBe('keep-me');
  });

  it('strips credential handle env vars unless allowlisted', async () => {
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

  it("preserves the configured runner's own auth key while stripping other secrets", async () => {
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
});

describe('runnerAuthEnvKeys', () => {
  it('maps the claude-code CLI runner to ANTHROPIC_API_KEY', () => {
    expect(runnerAuthEnvKeys({ kind: 'cli', tool: 'claude-code', model: 'auto' })).toEqual([
      'ANTHROPIC_API_KEY',
    ]);
  });

  it('maps the agent-sdk runner to ANTHROPIC_API_KEY', () => {
    expect(runnerAuthEnvKeys({ kind: 'agent-sdk', model: 'auto' })).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('maps a known api provider to its catalog auth env var', () => {
    expect(
      runnerAuthEnvKeys({
        kind: 'api',
        provider: 'openai',
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
        apiBase: 'https://example.com/v1',
        apiKey: 'env:CUSTOM_PROVIDER_KEY',
        model: 'm',
      }),
    ).toContain('CUSTOM_PROVIDER_KEY');
  });
});

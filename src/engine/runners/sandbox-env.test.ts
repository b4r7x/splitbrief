import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import { createSandboxEnv } from './sandbox-env.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];
let originalHome: string | undefined;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  originalHome = undefined;
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

  itUnix('seeds the sandbox HOME with credential entries from the real HOME', async () => {
    const fakeHome = createTempDir('sandbox-real-home');
    const projectDir = createTempDir('sandbox-env-creds');
    dirs.push(fakeHome, projectDir);

    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude', '.credentials.json'), '{"token":"secret"}');
    writeFileSync(join(fakeHome, '.npmrc'), '//registry/:_authToken=abc\n');

    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    const env = await createSandboxEnv(projectDir);

    const sandboxHome = env.HOME as string;
    expect(readFileSync(join(sandboxHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      '{"token":"secret"}',
    );
    expect(readFileSync(join(sandboxHome, '.npmrc'), 'utf-8')).toBe('//registry/:_authToken=abc\n');
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
});

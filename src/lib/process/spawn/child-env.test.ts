import { describe, it, expect } from 'vitest';
import { absolutePathEntries, createCommandEnv, createSanitizedChildEnv } from './child-env.js';

describe('createSanitizedChildEnv', () => {
  it('copies runtime values and explicit credentials without ambient secrets or controls', {
    timeout: 60_000,
  }, () => {
    const env = createSanitizedChildEnv(
      {
        LANG: 'C.UTF-8',
        HOME: '/host/home',
        PATH: '/project/bin',
        NODE_OPTIONS: '--require=/tmp/loader.js',
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_API_KEY: 'sk-anthropic',
      },
      ['OPENAI_API_KEY', 'HOME', 'NODE_OPTIONS'],
    );

    expect(env).toEqual({ LANG: 'C.UTF-8', OPENAI_API_KEY: 'sk-openai' });
  });
});

describe('createCommandEnv', () => {
  const source: NodeJS.ProcessEnv = {
    LANG: 'C.UTF-8',
    HOME: '/home/dev',
    USERPROFILE: '/home/dev',
    USER: 'dev',
    PATH: '/usr/bin::node_modules/.bin:./bin:/home/dev/.cargo/bin',
    TMPDIR: '/tmp/dev',
    JAVA_HOME: '/opt/jdk',
    GOMODCACHE: '/home/dev/go/pkg/mod',
    HTTPS_PROXY: 'http://proxy.local:3128',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
    OPENAI_API_KEY: 'sk-openai',
    ANTHROPIC_API_KEY: 'sk-anthropic',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_PROFILE: 'prod',
    GITHUB_TOKEN: 'ghp-token',
    NPM_TOKEN: 'npm-token',
    DATABASE_URL: 'postgres://user:pw@db/app',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    GIT_ASKPASS: '/home/dev/askpass.sh',
    XDG_RUNTIME_DIR: '/run/user/1000',
    NODE_OPTIONS: '--require=/tmp/loader.js',
    npm_config_userconfig: '/home/dev/.npmrc-ci',
    DISPLAY: ':0',
    RAILS_ENV: 'test',
    MISSING_PROJECT_SETTING: undefined,
  };

  it('keeps the account, temp, toolchain, proxy and CA keys a test tool needs', () => {
    const env = createCommandEnv(source);

    expect(env).toMatchObject({
      LANG: 'C.UTF-8',
      HOME: '/home/dev',
      USERPROFILE: '/home/dev',
      USER: 'dev',
      TMPDIR: '/tmp/dev',
      JAVA_HOME: '/opt/jdk',
      GOMODCACHE: '/home/dev/go/pkg/mod',
      HTTPS_PROXY: 'http://proxy.local:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
    });
  });

  it('keeps project settings, runtime options and values under ordinary names', () => {
    expect(createCommandEnv(source)).toMatchObject({
      NODE_OPTIONS: '--require=/tmp/loader.js',
      DATABASE_URL: 'postgres://user:pw@db/app',
      DISPLAY: ':0',
      XDG_RUNTIME_DIR: '/run/user/1000',
      RAILS_ENV: 'test',
    });
    expect(createCommandEnv(source)).not.toHaveProperty('MISSING_PROJECT_SETTING');
  });

  it('keeps the module mirror, SDK, browser and JVM option settings a build reads', () => {
    const toolchain = {
      GOPROXY: 'https://proxy.golang.org,direct',
      GOPRIVATE: 'git.corp/*',
      GONOSUMDB: 'git.corp/*',
      GONOPROXY: 'git.corp/*',
      GOINSECURE: 'dev.corp/*',
      ANDROID_HOME: '/opt/android',
      ANDROID_SDK_ROOT: '/opt/android',
      CHROME_BIN: '/usr/bin/chromium',
      PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
      JAVA_TOOL_OPTIONS: '-Xmx2g',
      MAVEN_OPTS: '-Xmx1g',
      GRADLE_OPTS: '-Dorg.gradle.daemon=false',
    };

    expect(createCommandEnv({ ...source, ...toolchain })).toMatchObject(toolchain);
  });

  it('drops credentials, agent sockets and credential helpers', () => {
    const env = createCommandEnv(source);

    for (const key of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_PROFILE',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
      'npm_config_userconfig',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it.each([
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'SSH_AUTH_SOCK',
    'SSH_ASKPASS',
    'GIT_ASKPASS',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'NPM_CONFIG_USERCONFIG',
    'npm_config_userconfig',
  ])('drops the credential selector or helper %s', (key) => {
    expect(createCommandEnv({ [key]: 'credential-access' })).not.toHaveProperty(key);
  });

  it('keeps only the absolute PATH entries', () => {
    expect(createCommandEnv(source).PATH).toBe('/usr/bin:/home/dev/.cargo/bin');
  });
});

describe('absolutePathEntries', () => {
  it('drops the relative and empty entries', () => {
    expect(absolutePathEntries('/usr/bin::bin:./tools:/opt/bin')).toBe('/usr/bin:/opt/bin');
  });

  it('is empty for a PATH with no absolute entry, or no PATH', () => {
    expect(absolutePathEntries('bin:.')).toBe('');
    expect(absolutePathEntries(undefined)).toBe('');
  });
});

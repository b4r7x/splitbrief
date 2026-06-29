import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import { PROVIDER_CATALOG } from '../../core/providers/catalog.js';
import { isProviderId } from '../../core/schemas/enums.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import { apiKeyEnvReference } from '../providers/client.js';

type RunnerLike = PlannerConfig | ImplementerConfig;

const AMBIENT_SECRET_KEYS = new Set([
  'NPM_TOKEN',
  'NPM_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'DOCKER_PASSWORD',
  'CI_JOB_TOKEN',
  'GITLAB_TOKEN',
  'BITBUCKET_TOKEN',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AZURE_OPENAI_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
]);

const SECRET_ENV_KEY_PATTERN =
  /_(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|URL|URI|DSN|CONNECTION)S?$/i;

const CREDENTIAL_HANDLE_KEYS = new Set([
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_userconfig',
]);

const CREDENTIAL_HANDLE_KEY_PATTERN =
  /(^|_)((TOKEN|CREDENTIAL|CREDENTIALS|AUTH|SECRET|PASSWORD)_FILE|ASKPASS|AUTH_SOCK)$/i;

const CLI_TOOL_AUTH_ENV: Partial<Record<string, string>> = {
  'claude-code': 'ANTHROPIC_API_KEY',
};

export function runnerAuthEnvKeys(runner: RunnerLike): string[] {
  const keys = new Set<string>();
  if ('apiKey' in runner) {
    const ref = apiKeyEnvReference(runner.apiKey);
    if (ref) keys.add(ref);
  }
  switch (runner.kind) {
    case 'api': {
      if (isProviderId(runner.provider)) {
        const envVar = PROVIDER_CATALOG[runner.provider].apiKeyEnv;
        if (envVar) keys.add(envVar);
      }
      break;
    }
    case 'agent-sdk':
      keys.add('ANTHROPIC_API_KEY');
      break;
    case 'cli': {
      const envVar = CLI_TOOL_AUTH_ENV[runner.tool];
      if (envVar) keys.add(envVar);
      break;
    }
  }
  return [...keys];
}

function isStrippedSecret(key: string, preserve: Set<string>): boolean {
  if (preserve.has(key)) return false;
  return (
    AMBIENT_SECRET_KEYS.has(key) ||
    CREDENTIAL_HANDLE_KEYS.has(key) ||
    SECRET_ENV_KEY_PATTERN.test(key) ||
    CREDENTIAL_HANDLE_KEY_PATTERN.test(key)
  );
}

export async function createSandboxEnv(
  projectDir: string,
  preserveEnvKeys: string[] = [],
): Promise<NodeJS.ProcessEnv> {
  const root = join(projectDir, SANDBOX_DIR);
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  const cache = join(root, 'cache');
  const config = join(root, 'config');
  const data = join(root, 'data');
  const npmCache = join(root, 'npm-cache');
  const pipCache = join(root, 'pip-cache');
  const cargoHome = join(root, 'cargo');
  await Promise.all(
    [home, tmp, cache, config, data, npmCache, pipCache, cargoHome].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  const preserve = new Set(preserveEnvKeys);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isStrippedSecret(key, preserve)) {
      env[key] = value;
    }
  }

  return {
    ...env,
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    npm_config_cache: npmCache,
    PIP_CACHE_DIR: pipCache,
    CARGO_HOME: cargoHome,
  };
}

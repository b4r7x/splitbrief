import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';

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

export async function createSandboxEnv(projectDir: string): Promise<NodeJS.ProcessEnv> {
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
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !AMBIENT_SECRET_KEYS.has(key)) {
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

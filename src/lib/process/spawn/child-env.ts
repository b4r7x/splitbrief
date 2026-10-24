import { delimiter, isAbsolute } from 'node:path';
import { isCredentialEnvironmentName } from '../../../utils/redact.js';

const CHILD_RUNTIME_ENV_KEYS = [
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'NO_COLOR',
  'FORCE_COLOR',
  'COLUMNS',
  'LINES',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
] as const;

const CREDENTIAL_ACCESS_ENV_KEYS = new Set([
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
]);

const CHILD_CONTROL_ENV_KEYS = new Set([
  ...CREDENTIAL_ACCESS_ENV_KEYS,
  'HOME',
  'USERPROFILE',
  'PATH',
  'PWD',
  'OLDPWD',
  'INIT_CWD',
  'CDPATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'RUBYOPT',
  'PERL5OPT',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

let userNodeEnv: { value: string | undefined } | undefined;

/**
 * Runs this process with `NODE_ENV=production`, so React and Ink load their production
 * build, and keeps the value the user started it with for the children it starts.
 */
export function runAsProduction(): void {
  userNodeEnv = { value: process.env['NODE_ENV'] };
  process.env['NODE_ENV'] = 'production';
}

/** `env` with the `NODE_ENV` the user started SPLITBRIEF with in place of its own: their value, or none. */
export function withUserNodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (userNodeEnv === undefined || env['NODE_ENV'] !== 'production') return env;
  const { NODE_ENV: _own, ...rest } = env;
  return userNodeEnv.value === undefined ? rest : { ...rest, NODE_ENV: userNodeEnv.value };
}

/**
 * The environment of every command SPLITBRIEF runs itself: plan and reviewer checks,
 * base re-runs, fix checks, renders, the formatter and the `--version` probe. These
 * commands inherit every defined variable except credential names, selectors and
 * helpers. Values under ordinary names still reach the commands. The real `HOME`
 * and `USERPROFILE` stay. `PATH` keeps only absolute entries, so it does not resolve
 * against the run workspace.
 */
export function createCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !isCredentialEnvironmentName(key) &&
      !CREDENTIAL_ACCESS_ENV_KEYS.has(key)
    ) {
      env[key] = value;
    }
  }
  env['PATH'] = absolutePathEntries(source['PATH']);
  return env;
}

/** `path` without its relative or empty entries, which would resolve against the working directory. */
export function absolutePathEntries(path: string | undefined): string {
  return (path ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter);
}

export function isSafePreservedChildEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !CHILD_CONTROL_ENV_KEYS.has(key);
}

export function createSanitizedChildEnv(
  source: NodeJS.ProcessEnv,
  preserveKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_RUNTIME_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of new Set(preserveKeys)) {
    const value = source[key];
    if (value !== undefined && isSafePreservedChildEnvKey(key)) env[key] = value;
  }
  return env;
}

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

const CHILD_CONTROL_ENV_KEYS = new Set([
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

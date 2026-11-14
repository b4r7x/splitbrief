import { isFlag, lookup } from './programs.js';

/** The options of npx and npm exec that run code other than the named tool. */
export const EXEC_CODE_FLAGS = new Set(['--package', '-p', '--call', '-c']);
/** The options of npx and npm exec that download a missing package despite `--no-install`. */
export const EXEC_DOWNLOAD_FLAGS = new Set(['--yes', '-y']);
export const UV_RUN_DOWNLOAD_FLAGS = new Set([
  '--with',
  '--with-editable',
  '--with-requirements',
  '-w',
]);
/** Subcommands of package and environment managers that run the program named after them. */
export const FORWARDERS: Readonly<Record<string, readonly string[]>> = {
  pnpm: ['exec'],
  yarn: ['exec'],
  bundle: ['exec'],
  uv: ['run'],
  poetry: ['run'],
  pipenv: ['run'],
  pdm: ['run'],
  hatch: ['run'],
  conda: ['run'],
  pixi: ['run'],
  rye: ['run'],
  mise: ['exec', 'x'],
  composer: ['exec'],
};
/**
 * pnpm's and yarn's own commands. Any other first word names a package script or an installed
 * program, and they run it: `pnpm tsx`, `yarn node` (yarn's `node` command runs node).
 */
export const PACKAGE_MANAGER_COMMANDS = new Set([
  'access',
  'add',
  'approve-builds',
  'audit',
  'autoclean',
  'bin',
  'c',
  'cache',
  'cat-file',
  'cat-index',
  'check',
  'config',
  'constraints',
  'create',
  'dedupe',
  'deploy',
  'dlx',
  'doctor',
  'env',
  'exec',
  'explain',
  'fetch',
  'find-hash',
  'generate-lock-entry',
  'global',
  'help',
  'i',
  'ignored-builds',
  'import',
  'info',
  'init',
  'install',
  'install-test',
  'it',
  'licenses',
  'link',
  'list',
  'ln',
  'login',
  'logout',
  'ls',
  'npm',
  'outdated',
  'owner',
  'pack',
  'patch',
  'patch-commit',
  'patch-remove',
  'plugin',
  'policies',
  'prune',
  'publish',
  'rb',
  'rebuild',
  'remove',
  'rm',
  'root',
  'search',
  'self-update',
  'set',
  'stage',
  'start',
  'store',
  't',
  'tag',
  'team',
  'test',
  'uninstall',
  'unlink',
  'unplug',
  'up',
  'update',
  'upgrade',
  'upgrade-interactive',
  'version',
  'versions',
  'why',
]);
/** Package scripts that start or stop the application: they do not verify a change. */
export const APPLICATION_SCRIPTS = new Set(['start', 'stop', 'restart']);
/** pnpm's and yarn's options that take the next word as their value. */
export const PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
  '--filter',
  '-F',
  '--filter-prod',
  '--dir',
  '-C',
  '--cwd',
  '--workspace-concurrency',
  '--reporter',
  '--loglevel',
  '--test-pattern',
  '--changed-files-ignore-pattern',
  '--resume-from',
  '--from',
  '--include',
  '--exclude',
  '--jobs',
  '-j',
]);
export const NPM_VALUE_OPTIONS = new Set([
  '--prefix',
  '-C',
  '--workspace',
  '-w',
  '--cache',
  '--userconfig',
  '--globalconfig',
  '--registry',
  '--loglevel',
  '--location',
  '--tag',
  '--scope',
]);
export const COMPOSER_VALUE_OPTIONS = new Set(['-d', '--working-dir']);
/** The options that run a package manager in another directory, on that directory's manifest. */
export const DIRECTORY_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  npm: ['--prefix', '-C'],
  pnpm: ['-C', '--dir'],
  yarn: ['--cwd'],
  bun: ['--cwd'],
  composer: ['-d', '--working-dir'],
};
/** pnpm's and yarn's words before the script or program they run, with the words each takes. */
const PACKAGE_MANAGER_PREFIXES: Readonly<Record<string, number>> = {
  run: 0,
  'run-script': 0,
  recursive: 0,
  workspaces: 0,
  foreach: 0,
  workspace: 1,
};

/** The program a scoped or versioned npx package name runs. */
export function npxProgram(tool: string): string {
  return tool.startsWith('@')
    ? tool.slice(tool.indexOf('/') + 1).replace(/@[^@]*$/, '')
    : tool.replace(/@[^@]*$/, '');
}

/** Where npm names one of `names` as its subcommand, or -1. */
export function npmSubcommandAt(tokens: readonly string[], names: readonly string[]): number {
  if ((tokens[0] ?? '').toLowerCase() !== 'npm') return -1;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (token === '--') return -1;
    if (isFlag(token)) {
      if (NPM_VALUE_OPTIONS.has(token)) index++;
      continue;
    }
    return names.includes(token) ? index : -1;
  }
  return -1;
}

export type Forwarded = { commands: string[][] } | { refusal: string };

/**
 * Where pnpm, yarn or bun name the command, script or program they run, past their options and
 * prefix words, and whether a `run` or `run-script` prefix names it a script.
 */
export function packageManagerWord(
  tokens: readonly string[],
): { index: number; afterRun: boolean } | null {
  let afterRun = false;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (isFlag(token)) {
      if (PACKAGE_MANAGER_VALUE_OPTIONS.has(token)) index++;
      continue;
    }
    const takes = lookup(PACKAGE_MANAGER_PREFIXES, token);
    if (takes !== undefined) {
      if (token === 'run' || token === 'run-script') afterRun = true;
      index += takes;
      continue;
    }
    return { index, afterRun };
  }
  return null;
}

/** The script or program pnpm or yarn runs when its first word is not one of its own commands. */
export function packageManagerForwarded(tokens: readonly string[]): Forwarded | null {
  const word = packageManagerWord(tokens);
  if (word === null || PACKAGE_MANAGER_COMMANDS.has(tokens[word.index] ?? '')) return null;
  return { commands: [tokens.slice(word.index)] };
}

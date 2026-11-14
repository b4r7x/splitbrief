export const SHELL_SYNTAX = /[|&;`$(){}<>]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the rule matches control characters.
export const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
export const REMOTE = /:\/\/|^(?:npm|jsr):/i;
/** A script file of deno or bun, told apart from a package script or task name by its extension. */
export const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;
export const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
]);
export const WRAPPERS = new Set([
  'env',
  'sudo',
  'doas',
  'su',
  'xargs',
  'nohup',
  'timeout',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'chroot',
  'time',
  'exec',
  'eval',
  'command',
  'builtin',
  'source',
  '.',
  'watch',
  'busybox',
  'toybox',
  'nix-shell',
  'nix',
]);
export const NOT_VERIFICATION = new Set([
  'git',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'dd',
  'chmod',
  'chown',
  'curl',
  'wget',
  'ssh',
  'scp',
  'nc',
  'ncat',
  'socat',
  'telnet',
  'ftp',
  'sftp',
  'rsync',
  'kill',
  'pkill',
  'killall',
  'shutdown',
  'reboot',
  'docker',
  'podman',
  'kubectl',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'brew',
  'apk',
  'pacman',
  'osascript',
  'sed',
  'tar',
]);
export const LAUNCHERS: readonly (readonly string[])[] = [
  ['bunx'],
  ['uvx'],
  ['pnpx'],
  ['pipx', 'run'],
  ['pnpm', 'dlx'],
  ['yarn', 'dlx'],
  ['bun', 'x'],
  ['uv', 'tool', 'run'],
  ['corepack'],
  ['pnpm', 'env'],
  ['yarn', 'set'],
];
export const SETUP_VERBS = new Set([
  'install',
  'i',
  'ci',
  'it',
  'cit',
  'install-test',
  'install-ci-test',
  'rebuild',
  'wheel',
  'add',
  'get',
  'generate',
  'sync',
  'download',
  'restore',
  'fetch',
  'update',
  'upgrade',
  'self-update',
  'publish',
  'deploy',
  'init',
  'create',
  'link',
  'require',
  'remove',
  'uninstall',
  'tidy',
  'vendor',
  'deps.get',
  'deps.update',
  'up',
  'lock',
  'dedupe',
  'prune',
  'shrinkwrap',
  'generate-lockfile',
  'wrapper',
]);
/** These setup verbs belong to specific tools; elsewhere they can name verification targets. */
export const SCOPED_SETUP_VERBS: Readonly<Record<string, readonly string[]>> = {
  up: ['pnpm', 'yarn'],
  lock: ['poetry', 'uv', 'bundle'],
  dedupe: ['npm', 'pnpm', 'yarn'],
  prune: ['npm', 'pnpm'],
  shrinkwrap: ['npm', 'pnpm'],
  'generate-lockfile': ['cargo'],
  wrapper: ['gradle'],
};
export const PACKAGE_MUTATIONS: Readonly<Record<string, readonly string[]>> = {
  npm: ['config', 'pkg', 'version'],
  pnpm: ['config', 'pkg', 'version'],
  yarn: ['config', 'pkg', 'version'],
};
export const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
/** First operands that group subcommands: the setup verb is the operand after them. */
export const COMMAND_GROUPS = new Set(['tool', 'mod', 'pip', 'global']);
/** Programs that take several goals or targets: each operand can be a setup verb. */
export const GOAL_RUNNERS = new Set(['mvn', 'gradle', 'make', 'just', 'rake', 'ant', 'sbt']);
/** Programs that install the project's dependencies when they get no operand. */
export const BARE_INSTALLERS = new Set(['yarn', 'bundle', 'composer']);
/**
 * The options of the programs that run the project's own build or task file: those that take code
 * to run, and those that read another definition file or run in another directory. `valueLetters`
 * names the short options that take a value when the program clusters short options (`-kC dir`);
 * null when it does not.
 */
export const TASK_RUNNERS: Readonly<
  Record<
    string,
    {
      code: readonly string[];
      definition: readonly string[];
      valueLetters: string | null;
    }
  >
> = {
  make: {
    code: ['-E', '--eval'],
    definition: ['-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir'],
    valueLetters: 'jloOW',
  },
  just: {
    code: ['-c', '--command', '--shell', '--shell-arg'],
    definition: ['-d', '--working-directory', '-f', '--justfile', '-g', '--global-justfile'],
    valueLetters: 'sE',
  },
  rake: {
    code: [
      '-e',
      '--execute',
      '-E',
      '--execute-continue',
      '-p',
      '--execute-print',
      '-r',
      '--require',
    ],
    definition: [
      '-f',
      '--rakefile',
      '-C',
      '--directory',
      '-R',
      '--rakelibdir',
      '--rakelib',
      '-g',
      '--system',
    ],
    valueLetters: 'DIjTtW',
  },
  gradle: {
    code: ['-I', '--init-script'],
    definition: [],
    valueLetters: null,
  },
  mix: { code: ['-e', '--eval'], definition: [], valueLetters: null },
};
/** The project's build wrappers: each runs as its tool, and only while this run changed none of its files. */
export const PROJECT_WRAPPERS: Readonly<
  Record<string, { tool: string; files: readonly string[]; dirs: readonly string[] }>
> = {
  './gradlew': { tool: 'gradle', files: ['gradlew'], dirs: ['gradle/wrapper'] },
  './mvnw': { tool: 'mvn', files: ['mvnw'], dirs: ['.mvn/wrapper'] },
};
/** The task files each task runner reads in its directory, and the directories it loads tasks from. */
export const TASK_FILES: Readonly<
  Record<string, { files: readonly string[]; dirs: readonly string[] }>
> = {
  make: { files: ['Makefile', 'makefile', 'GNUmakefile'], dirs: [] },
  just: { files: ['justfile', 'Justfile', '.justfile'], dirs: [] },
  rake: { files: ['Rakefile', 'rakefile', 'Rakefile.rb', 'rakefile.rb'], dirs: ['rakelib'] },
};
export const TASK_CODE_GOALS: Readonly<Record<string, readonly string[]>> = {
  mvn: [
    'exec:',
    'antrun:',
    'org.codehaus.mojo:exec-maven-plugin:',
    'org.apache.maven.plugins:maven-antrun-plugin:',
  ],
  rails: ['runner', 'r'],
  mix: ['eval'],
};
/** The make variables that set the shell, its flags, the makefiles or make's own options. */
export const MAKE_CONTROL_VARIABLES = new Set([
  'SHELL',
  '.SHELLFLAGS',
  'MAKEFILES',
  'MAKEFLAGS',
  'GNUMAKEFLAGS',
]);

export function isFlag(token: string): boolean {
  return token.startsWith('-');
}

/** A table's own entry for a command word: `constructor` or `toString` names no entry. */
export function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

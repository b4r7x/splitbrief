import { isAbsolute, posix } from 'node:path';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { CODE_LOAD_FLAGS } from '../planning/sanitize-discovered-validation.js';

const SHELL_SYNTAX = /[|&;`$(){}<>]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the rule matches control characters.
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const REMOTE = /:\/\/|^(?:npm|jsr):/i;
/** A script file of deno or bun, told apart from a package script or task name by its extension. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;
const SHELLS = new Set([
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
const WRAPPERS = new Set([
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
const NOT_VERIFICATION = new Set([
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
/** Interpreters whose first operand is a script file, named without a version (`python3.12`). */
const SCRIPT_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'pypy',
  'ruby',
  'perl',
  'php',
  'lua',
  'rscript',
  'tsx',
  'ts-node',
  'elixir',
  'iex',
  'erl',
  'groovy',
  'scala',
  'kotlin',
]);
/**
 * Interpreters whose first operand is a subcommand: the subcommands that take inline code, and
 * whether their options can carry it too. deno takes inline code only as `deno eval`.
 */
const SUBCOMMAND_INTERPRETERS: Readonly<
  Record<string, { inline: readonly string[]; codeOptions: boolean }>
> = {
  deno: { inline: ['eval', 'repl'], codeOptions: false },
  bun: { inline: ['repl'], codeOptions: true },
};
const INLINE_CODE_FLAGS = new Set([...CODE_LOAD_FLAGS, '-E', '--loader', '--experimental-loader']);
/** elixir and iex take whole-word options; `--erl` hands its value to erl, which can run code. */
const ELIXIR_OPTIONS = {
  flags: new Set(['-e', '--eval', '-r', '-pr', '--rpc-eval', '--erl']),
  clustered: false,
  scriptOperand: true,
  values: new Set(['-pa', '-pz', '--name', '--sname', '--cookie']),
};
/**
 * Interpreters whose code options differ from the shared table. `clustered: false` matches whole
 * option words, `values` lists the options whose next word is their value, not the script.
 */
const INTERPRETER_CODE_OPTIONS: Readonly<
  Record<
    string,
    {
      flags: ReadonlySet<string>;
      clustered: boolean;
      scriptOperand: boolean;
      values?: ReadonlySet<string>;
    }
  >
> = {
  erl: { flags: new Set(['-eval', '-s', '-run']), clustered: false, scriptOperand: false },
  elixir: ELIXIR_OPTIONS,
  iex: ELIXIR_OPTIONS,
  groovy: {
    flags: new Set(['-e']),
    clustered: false,
    scriptOperand: true,
    values: new Set(['-cp', '-classpath', '--classpath', '-c', '--encoding']),
  },
  scala: {
    flags: new Set(['-e']),
    clustered: false,
    scriptOperand: true,
    values: new Set(['-cp', '-classpath', '-encoding']),
  },
  kotlin: {
    flags: new Set(['-e', '-expression']),
    clustered: false,
    scriptOperand: true,
    values: new Set(['-cp', '-classpath', '-howtorun']),
  },
  php: {
    flags: new Set([...INLINE_CODE_FLAGS, '-B', '-R', '-F']),
    clustered: true,
    scriptOperand: true,
  },
};
/** The letters of each interpreter's short options that take a value, attached or next. */
const VALUE_LETTERS: Readonly<Record<string, string>> = {
  python: 'WX',
  pypy: 'WX',
  ruby: 'IC',
  perl: 'IMmx',
  php: 'cdz',
  node: 'C',
  nodejs: 'C',
};
/** The options of npx and npm exec that run code other than the named tool. */
const EXEC_CODE_FLAGS = new Set(['--package', '-p', '--call', '-c']);
/** The options of npx and npm exec that download a missing package despite `--no-install`. */
const EXEC_DOWNLOAD_FLAGS = new Set(['--yes', '-y']);
const UV_RUN_DOWNLOAD_FLAGS = new Set(['--with', '--with-editable', '--with-requirements', '-w']);
/** Subcommands of package and environment managers that run the program named after them. */
const FORWARDERS: Readonly<Record<string, readonly string[]>> = {
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
const PACKAGE_MANAGER_COMMANDS = new Set([
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
const APPLICATION_SCRIPTS = new Set(['start', 'stop', 'restart']);
/** pnpm's and yarn's options that take the next word as their value. */
const PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
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
const NPM_VALUE_OPTIONS = new Set([
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
const COMPOSER_VALUE_OPTIONS = new Set(['-d', '--working-dir']);
/** The options that run a package manager in another directory, on that directory's manifest. */
const DIRECTORY_OPTIONS: Readonly<Record<string, readonly string[]>> = {
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
const LAUNCHERS: readonly (readonly string[])[] = [
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
const SETUP_VERBS = new Set([
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
const SCOPED_SETUP_VERBS: Readonly<Record<string, readonly string[]>> = {
  up: ['pnpm', 'yarn'],
  lock: ['poetry', 'uv', 'bundle'],
  dedupe: ['npm', 'pnpm', 'yarn'],
  prune: ['npm', 'pnpm'],
  shrinkwrap: ['npm', 'pnpm'],
  'generate-lockfile': ['cargo'],
  wrapper: ['gradle'],
};
const PACKAGE_MUTATIONS: Readonly<Record<string, readonly string[]>> = {
  npm: ['config', 'pkg', 'version'],
  pnpm: ['config', 'pkg', 'version'],
  yarn: ['config', 'pkg', 'version'],
};
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
/** First operands that group subcommands: the setup verb is the operand after them. */
const COMMAND_GROUPS = new Set(['tool', 'mod', 'pip', 'global']);
/** Programs that take several goals or targets: each operand can be a setup verb. */
const GOAL_RUNNERS = new Set(['mvn', 'gradle', 'make', 'just', 'rake', 'ant', 'sbt']);
/** Programs that install the project's dependencies when they get no operand. */
const BARE_INSTALLERS = new Set(['yarn', 'bundle', 'composer']);
/**
 * The options of the programs that run the project's own build or task file: those that take code
 * to run, and those that read another definition file or run in another directory. `valueLetters`
 * names the short options that take a value when the program clusters short options (`-kC dir`);
 * null when it does not.
 */
const TASK_RUNNERS: Readonly<
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
const PROJECT_WRAPPERS: Readonly<
  Record<string, { tool: string; files: readonly string[]; dirs: readonly string[] }>
> = {
  './gradlew': { tool: 'gradle', files: ['gradlew'], dirs: ['gradle/wrapper'] },
  './mvnw': { tool: 'mvn', files: ['mvnw'], dirs: ['.mvn/wrapper'] },
};
/** The task files each task runner reads in its directory, and the directories it loads tasks from. */
const TASK_FILES: Readonly<Record<string, { files: readonly string[]; dirs: readonly string[] }>> =
  {
    make: { files: ['Makefile', 'makefile', 'GNUmakefile'], dirs: [] },
    just: { files: ['justfile', 'Justfile', '.justfile'], dirs: [] },
    rake: { files: ['Rakefile', 'rakefile', 'Rakefile.rb', 'rakefile.rb'], dirs: ['rakelib'] },
  };
const TASK_CODE_GOALS: Readonly<Record<string, readonly string[]>> = {
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
const MAKE_CONTROL_VARIABLES = new Set([
  'SHELL',
  '.SHELLFLAGS',
  'MAKEFILES',
  'MAKEFLAGS',
  'GNUMAKEFLAGS',
]);

const code = (words: Iterable<string>): string =>
  [...words].map((word) => `\`${word}\``).join(', ');

const taskRunnerOptions = (kind: 'code' | 'definition'): string =>
  code(
    Object.entries(TASK_RUNNERS).flatMap(([program, options]) =>
      options[kind].map((option) => `${program} ${option}`),
    ),
  );

/** The reviewer command policy in words: the plan prompt states it, the policy below enforces it. */
export const REVIEWER_COMMAND_RULES: readonly string[] = [
  'Write each command as one program and its arguments: no shell operator, substitution or redirect (`| & ; < > $ ( ) { }` or backticks), no control character (a line break or a tab), no environment variable before the program, no `cd`, no URL and no path outside the run workspace, also not after `KEY=` or attached to an option (`DESTDIR=/`, `-o/tmp/x`).',
  "Run an installed program by its name, never by path: `bin/test` and `sub/gradlew` are refused. The project's own `./gradlew` and `./mvnw` are the exception: they run as `gradle` and `mvn` under the same rules, and only when this run changed none of their wrapper files (`gradlew` and `gradle/wrapper/`, `mvnw` and `.mvn/wrapper/`).",
  `A shell (${code(SHELLS)}) and a program that runs another command line (${code(WRAPPERS)}, \`npm explore\`) are refused. ${code(Object.entries(FORWARDERS).flatMap(([program, subs]) => subs.map((sub) => `${program} ${sub}`)))} and \`python -m\` are checked by the program they run. Forwarders may take options. The program is the first word after the subcommand that does not follow an option; a word after an option can be its value, so it is checked as a possible program start too. Write a path value as \`--option=value\`. \`uv run --with\` is refused because it downloads a package; \`mise exec\` runs only as \`mise exec -- <program>\`, because it installs the tools named before \`--\`. A first word that is not a command of \`pnpm\` or \`yarn\` is a script or program they run, and it is checked the same way (\`pnpm tsx\`, \`yarn node\`).`,
  `An interpreter, under any version of its name (\`python3.12\`, \`pypy3\`), runs a project script (\`python manage.py test\`, \`php artisan test\`) or a module (\`python -m pytest\`). It never runs inline code: \`node -e\`, \`python -c\`, \`deno eval\`, \`elixir -e\`, \`elixir --erl\`, \`iex -e\`, \`groovy -e\`, \`scala -e\`, \`kotlin -e\`, \`erl -eval\`, \`erl -s\`, \`erl -run\`, and \`php -r\`, \`php -B\`, \`php -R\`, \`php -F\`, \`php -E\` are refused. Interpreter option values are not code: \`perl -Mstrict t/x.t\`, \`php -c php.ini artisan test\` and \`php -dmemory_limit=1G artisan test\` can run. A build or task runner runs no inline code either: ${taskRunnerOptions('code')} are refused. So are ${code(Object.entries(TASK_CODE_GOALS).flatMap(([program, goals]) => goals.map((goal) => `${program} ${goal}${goal.endsWith(':') ? '*' : ''}`)))}, and \`mix do\` checks each task it chains as its own \`mix\` command. A \`make\` operand cannot set ${code(MAKE_CONTROL_VARIABLES)} or assign with \`!=\`.`,
  `\`npx\` runs only as \`npx --no-install <tool>\`, and \`npm exec\` only with \`--no-install\`; neither takes \`--yes\` or \`-y\`. A launcher that downloads and runs a package is refused: ${code(LAUNCHERS.map((pattern) => pattern.join(' ')))}, \`go run <package>@<version>\`.`,
  `A setup command is refused: a program whose subcommand or goal is ${code([...SETUP_VERBS].filter((verb) => SCOPED_SETUP_VERBS[verb] === undefined))} (\`npm ci\`, \`pip install\`, \`go generate\`, \`go mod tidy\`, \`mvn install\`), and a bare ${code(BARE_INSTALLERS)}. These setup verbs apply only to their named tools: ${code(Object.entries(SCOPED_SETUP_VERBS).flatMap(([verb, programs]) => programs.map((program) => `${program} ${verb}`)))}. \`npm run <script>\` and \`npm run-script <script>\` name package scripts, not setup verbs. A verification target such as \`make lock\` can run. An operand after an option can be the option's value, so it is checked too: write the subcommand or target before the options (\`cargo test --locked sync\`, \`pytest tests/ -k install -v\`).`,
  `Package state commands are refused: ${code(Object.entries(PACKAGE_MUTATIONS).flatMap(([program, subs]) => subs.map((sub) => `${program} ${sub}`)))}. All forms of \`config\` and \`pkg\` are refused. An \`npm\`, \`pnpm\` or \`yarn\` \`audit\` with \`fix\` or \`--fix\` is refused; an audit without a fix can run.`,
  `\`find\` with ${code(FIND_ACTIONS)} is refused because it changes files or runs commands. Other \`find\` checks can run.`,
  `A program that does not verify a change is refused: ${code(NOT_VERIFICATION)}. ${code(
    Object.entries(TASK_RUNNERS)
      .filter(([, options]) => options.definition.length > 0)
      .map(([program]) => program),
  )} run only on the project's own task file, in its directory: ${taskRunnerOptions('definition')} are refused.`,
  `A package script in any \`package.json\` or \`composer.json\` of the workspace, a \`Makefile\`, \`justfile\`, \`Rakefile\` or \`rakelib\` task, a build wrapper, or an interpreter script that this run changed or created is refused. A test file is not a check definition: a test this run wrote or changed runs (\`node --test test/new.test.js\`). \`deno task\` tasks and \`mix.exs\` aliases are not compared. A \`package.json\` script named ${code(APPLICATION_SCRIPTS)} is refused in every form (\`npm start\`, \`pnpm --filter x start\`, \`yarn workspace x run start\`): it starts or stops the application and does not verify a change.`,
];

function isFlag(token: string): boolean {
  return token.startsWith('-');
}

/** A table's own entry for a command word: `constructor` or `toString` names no entry. */
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The build wrapper a first word names, by its exact spelling: `sub/gradlew` names none. */
function projectWrapper(first: string): (typeof PROJECT_WRAPPERS)[string] | undefined {
  return lookup(PROJECT_WRAPPERS, first);
}

/** The words after the program, without the values of the package manager's value options. */
function argumentsWithoutValues(tokens: readonly string[]): string[] {
  const program = (tokens[0] ?? '').toLowerCase();
  const values =
    program === 'npm'
      ? NPM_VALUE_OPTIONS
      : program === 'pnpm' || program === 'yarn' || program === 'bun'
        ? PACKAGE_MANAGER_VALUE_OPTIONS
        : program === 'composer'
          ? COMPOSER_VALUE_OPTIONS
          : null;
  return tokens.slice(1).filter((_, index) => values?.has(tokens[index] ?? '') !== true);
}

/** The words after the program that are not options, nor package manager option values. */
function operands(tokens: readonly string[]): string[] {
  return argumentsWithoutValues(tokens).filter((token) => !isFlag(token));
}

/**
 * An argument naming a place outside the run workspace: an absolute path or a `..` segment, also as
 * the value after `=` (`--prefix=/x`, `DESTDIR=/`) or attached to a short option (`-o/tmp/x`).
 */
function leavesWorkspace(token: string): boolean {
  const values = [
    token,
    token.slice(token.indexOf('=') + 1),
    /^-[A-Za-z]./s.test(token) ? token.slice(2) : token,
  ];
  return values.some((value) => isAbsolute(value) || value.split(/[\\/]/).includes('..'));
}

/** An interpreter's name without the version an install can carry (`python3.12`, `pypy3`). */
function interpreterName(program: string): string {
  return program.toLowerCase().replace(/[\d.]+$/, '');
}

type InterpreterCall =
  | { kind: 'inline' }
  | { kind: 'module'; command: string[] }
  | { kind: 'script'; file: string };

function interpreterCall(tokens: readonly string[]): InterpreterCall | null {
  const program = interpreterName(tokens[0] ?? '');
  const subcommands = lookup(SUBCOMMAND_INTERPRETERS, program);
  if (!SCRIPT_INTERPRETERS.has(program) && subcommands === undefined) return null;
  const codeOptions = lookup(INTERPRETER_CODE_OPTIONS, program);
  const codeFlags = codeOptions?.flags ?? INLINE_CODE_FLAGS;
  let runs = false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index] ?? '';
    if (arg === '-') return { kind: 'inline' };
    if (!isFlag(arg) || arg === '--') {
      if (codeOptions?.scriptOperand === false) continue;
      if (arg === '--') index++;
      const operand = tokens[index];
      if (operand === undefined) return null;
      if (subcommands === undefined) return { kind: 'script', file: operand };
      if (!runs && subcommands.inline.includes(operand)) return { kind: 'inline' };
      if (SCRIPT_FILE.test(operand)) return { kind: 'script', file: operand };
      // `deno run x.ts` and `bun run x.ts` run the file after `run`; `bun run test` runs a script.
      if (runs || operand !== 'run') return null;
      runs = true;
      continue;
    }
    if (subcommands?.codeOptions === false) continue;
    if ((program === 'python' || program === 'pypy') && arg.startsWith('-m')) {
      const next = arg === '-m' ? index + 2 : index + 1;
      const module = arg === '-m' ? tokens[index + 1] : arg.slice(2);
      return {
        kind: 'module',
        command: module === undefined ? [] : [module, ...tokens.slice(next)],
      };
    }
    if (arg.startsWith('--') || codeOptions?.clustered === false) {
      if (codeFlags.has(arg.replace(/=.*$/s, ''))) return { kind: 'inline' };
      if (codeOptions?.values?.has(arg) === true) index++;
      continue;
    }
    const letters = arg.slice(1);
    for (const [offset, letter] of [...letters].entries()) {
      if (lookup(VALUE_LETTERS, program)?.includes(letter) === true) {
        if (offset === letters.length - 1) index++;
        break;
      }
      if (codeFlags.has(`-${letter}`)) return { kind: 'inline' };
    }
  }
  return null;
}

/** The program a scoped or versioned npx package name runs. */
function npxProgram(tool: string): string {
  return tool.startsWith('@')
    ? tool.slice(tool.indexOf('/') + 1).replace(/@[^@]*$/, '')
    : tool.replace(/@[^@]*$/, '');
}

/** Where npm names one of `names` as its subcommand, or -1. */
function npmSubcommandAt(tokens: readonly string[], names: readonly string[]): number {
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

type Forwarded = { commands: string[][] } | { refusal: string };

/**
 * Where pnpm, yarn or bun name the command, script or program they run, past their options and
 * prefix words, and whether a `run` or `run-script` prefix names it a script.
 */
function packageManagerWord(
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
function packageManagerForwarded(tokens: readonly string[]): Forwarded | null {
  const word = packageManagerWord(tokens);
  if (word === null || PACKAGE_MANAGER_COMMANDS.has(tokens[word.index] ?? '')) return null;
  return { commands: [tokens.slice(word.index)] };
}

/** The command line npx, npm exec, a forwarder's subcommand, pnpm or yarn hands on. */
function forwarded(tokens: readonly string[]): Forwarded | null {
  const program = (tokens[0] ?? '').toLowerCase();
  const exec = npmSubcommandAt(tokens, ['exec', 'x']);
  if (program === 'npx' || exec !== -1) {
    const name = program === 'npx' ? 'npx' : 'npm exec';
    const start = program === 'npx' ? 1 : exec + 1;
    const own = tokens.slice(start);
    const toolIndex = own.findIndex((token) => !isFlag(token));
    const flags = toolIndex === -1 ? own : own.slice(0, toolIndex);
    if (program === 'npx' ? tokens[1] !== '--no-install' : !flags.includes('--no-install')) {
      return { refusal: `runs ${name} without --no-install` };
    }
    if (flags.some((flag) => EXEC_DOWNLOAD_FLAGS.has(flag.replace(/=.*$/s, '')))) {
      return { refusal: `runs ${name} with --yes, which downloads a missing package` };
    }
    if (flags.some((flag) => EXEC_CODE_FLAGS.has(flag.replace(/=.*$/s, '')))) {
      return { refusal: `runs code through ${name}` };
    }
    const tool = own[toolIndex];
    if (tool === undefined) return { refusal: `runs ${name} without a program` };
    return { commands: [[npxProgram(tool), ...own.slice(toolIndex + 1)]] };
  }
  const subs = lookup(FORWARDERS, program) ?? [];
  const at = tokens.findIndex((token, index) => index > 0 && subs.includes(token));
  if (at === -1) {
    return program === 'pnpm' || program === 'yarn' ? packageManagerForwarded(tokens) : null;
  }
  const sub = tokens[at];
  const rest = tokens.slice(at + 1);
  if (rest[0] === '--') return { commands: [rest.slice(1)] };
  // mise installs the tools named before `--` and runs a shell when no program follows it.
  if (program === 'mise')
    return { refusal: `runs ${program} ${sub} without -- before its program` };
  if (
    program === 'uv' &&
    rest.some(
      (token) => UV_RUN_DOWNLOAD_FLAGS.has(token.replace(/=.*$/s, '')) || /^-w./s.test(token),
    )
  ) {
    return { refusal: 'downloads and runs a package (uv run --with)' };
  }
  return {
    commands: leadingOperands(rest).map((index) => {
      const token = rest[index] ?? '';
      // hatch runs `<environment>:<command>` in that environment.
      const first = program === 'hatch' ? token.slice(token.lastIndexOf(':') + 1) : token;
      return [first, ...rest.slice(index + 1)];
    }),
  };
}

/** A word after which a program runs a script or another program, which the walk does not read. */
function handsOn(program: string, token: string): boolean {
  if (program === 'npx' || token === 'run' || token === 'run-script') return true;
  if (program === 'npm' && (token === 'exec' || token === 'x')) return true;
  return lookup(FORWARDERS, program)?.includes(token) === true;
}

/**
 * The indexes of the operands that can name what a command runs. An operand after an option can be
 * the option's value (`go -C . generate`, `uv run --python 3.12 pytest`), so the walk ends at the
 * first operand that follows no option; `--option=value` holds its own value. An operand that
 * `takesMore` names (a command group: `go -C . mod tidy`) does not end the walk.
 */
function leadingOperands(
  args: readonly string[],
  takesMore: (operand: string) => boolean = () => false,
): number[] {
  const indexes: number[] = [];
  for (const [index, token] of args.entries()) {
    if (isFlag(token)) continue;
    indexes.push(index);
    const previous = args[index - 1];
    const followsOption = previous !== undefined && isFlag(previous) && !previous.includes('=');
    if (!followsOption && !takesMore(token)) break;
  }
  return indexes;
}

/**
 * The operands that can name a program's subcommand. The walk ends before a word that hands on to
 * a script or program (`npm --silent run update`): the forwarded walk checks those.
 */
function subcommandWords(tokens: readonly string[]): string[] {
  const program = (tokens[0] ?? '').toLowerCase();
  const args = argumentsWithoutValues(tokens);
  const words: string[] = [];
  for (const index of leadingOperands(args, (token) => COMMAND_GROUPS.has(token))) {
    const token = args[index] ?? '';
    if (handsOn(program, token)) break;
    words.push(token);
  }
  return words;
}

function setupRefusal(program: string, tokens: readonly string[]): string | null {
  if (operands(tokens).length === 0) {
    return BARE_INSTALLERS.has(program) ? `runs ${program} with no argument, which installs` : null;
  }
  const checked = GOAL_RUNNERS.has(program) ? operands(tokens) : subcommandWords(tokens);
  const at = checked.findIndex(
    (word) =>
      SETUP_VERBS.has(word) && (lookup(SCOPED_SETUP_VERBS, word)?.includes(program) ?? true),
  );
  if (at === -1) return null;
  const group = GOAL_RUNNERS.has(program) ? [] : checked.slice(at - 1, at);
  const named = [...group.filter((word) => COMMAND_GROUPS.has(word)), ...checked.slice(at, at + 1)];
  return `runs a setup command (${[program, ...named].join(' ')})`;
}

function launcherRefusal(program: string, tokens: readonly string[]): string | null {
  const words = [program, ...operands(tokens)];
  const launcher = LAUNCHERS.find((pattern) =>
    pattern.every((word, index) => words[index] === word),
  );
  if (launcher !== undefined) return `downloads and runs a package (${launcher.join(' ')})`;
  if (program === 'go' && words[1] === 'run' && words.slice(2).some((word) => word.includes('@'))) {
    return 'downloads and runs a package (go run <package>@<version>)';
  }
  return null;
}

const TASK_OPTION_KINDS = ['code', 'definition'] as const;

/** Whether a token is a build or task runner's option that takes code or reads another definition. */
function taskRunnerOption(
  program: string,
  token: string,
): (typeof TASK_OPTION_KINDS)[number] | undefined {
  const runner = lookup(TASK_RUNNERS, program);
  if (runner === undefined || !isFlag(token)) return undefined;
  const long = (option: string) => option.startsWith('--');
  if (token.startsWith('--')) {
    // getopt and OptionParser take an unambiguous prefix of a long option: `--ev` is `--eval`.
    const name = token.replace(/=.*$/s, '');
    if (name.length <= 2) return undefined;
    return TASK_OPTION_KINDS.find((kind) =>
      runner[kind].some((option) => long(option) && option.startsWith(name)),
    );
  }
  if (runner.valueLetters === null) {
    return TASK_OPTION_KINDS.find((kind) =>
      runner[kind].some((option) => !long(option) && token.startsWith(option)),
    );
  }
  for (const letter of token.slice(1)) {
    const kind = TASK_OPTION_KINDS.find((each) => runner[each].includes(`-${letter}`));
    if (kind !== undefined) return kind;
    if (runner.valueLetters.includes(letter)) return undefined;
  }
  return undefined;
}

/** A `make` operand that sets the shell, its flags, the makefiles or make's options, or runs code. */
function makeVariableRefusal(tokens: readonly string[]): string | null {
  for (const token of operands(tokens)) {
    const assignment = /^\s*([^\s:+?!=]+)\s*(:{0,3}|[+?!])=/.exec(token);
    if (assignment === null) continue;
    if (assignment[2] === '!') return 'runs inline code';
    const name = assignment[1] ?? '';
    if (MAKE_CONTROL_VARIABLES.has(name)) return `sets the make variable ${name}`;
  }
  return null;
}

function taskRunnerRefusal(program: string, tokens: readonly string[]): string | null {
  const variable = program === 'make' ? makeVariableRefusal(tokens) : null;
  if (variable !== null) return variable;
  const goals = lookup(TASK_CODE_GOALS, program);
  const words = operands(tokens);
  if (
    (GOAL_RUNNERS.has(program) ? words : words.slice(0, 1)).some((word) =>
      goals?.some((goal) => (goal.endsWith(':') ? word.startsWith(goal) : word === goal)),
    )
  ) {
    return 'runs inline code';
  }
  for (const token of tokens.slice(1)) {
    const kind = taskRunnerOption(program, token);
    if (kind === 'code') return 'runs inline code';
    if (kind === 'definition') return `runs ${program} in another directory or on another file`;
  }
  return null;
}

/** `mix do a x + b y` (or `a x, b y`) runs each task in turn, so each is checked as its own `mix`. */
function mixTasksRefusal(tokens: readonly string[]): string | null {
  const tasks: string[][] = [];
  let task: string[] = [];
  for (const token of tokens.slice(tokens.indexOf('do') + 1)) {
    if (token === '+' || token.endsWith(',')) {
      tasks.push(token === '+' ? task : [...task, token.slice(0, -1)]);
      task = [];
      continue;
    }
    task.push(token);
  }
  tasks.push(task);
  for (const each of tasks) {
    const refusal = tokensRefusal(['mix', ...each]);
    if (refusal !== null) return refusal;
  }
  return null;
}

function tokensRefusal(tokens: readonly string[]): string | null {
  const first = tokens[0];
  if (first === undefined || first === '') return 'names no program';
  if (tokens.some((token) => CONTROL_CHARACTER.test(token))) return 'contains a control character';
  if (tokens.some((token) => SHELL_SYNTAX.test(token))) return 'contains a shell operator';
  if (first.includes('=')) return 'sets an environment variable before the program';
  const wrapper = projectWrapper(first);
  if (wrapper !== undefined) return tokensRefusal([wrapper.tool, ...tokens.slice(1)]);
  if (first.includes('/') || first.includes('\\')) return 'runs a program by path';
  if (tokens.some((token) => REMOTE.test(token))) return 'names a URL or a remote package';
  if (tokens.some(leavesWorkspace)) return 'names a path outside the run workspace';
  const program = first.toLowerCase();
  if (program === 'cd') return 'changes the directory';
  if (SHELLS.has(program)) return `runs the shell ${program}`;
  if (WRAPPERS.has(program)) return `runs another command line through ${program}`;
  if (npmSubcommandAt(tokens, ['explore']) !== -1) {
    return 'runs another command line through npm explore';
  }
  if (NOT_VERIFICATION.has(program)) return `runs ${program}, which does not verify a change`;
  const words = operands(tokens);
  const mutations = lookup(PACKAGE_MUTATIONS, program);
  const mutation = mutations?.find((sub) => words[0] === sub);
  if (mutation !== undefined) return `runs ${program} ${mutation}, which changes package state`;
  if (
    mutations !== undefined &&
    words[0] === 'audit' &&
    tokens.slice(1).some((token) => token === 'fix' || token.replace(/=.*$/s, '') === '--fix')
  ) {
    return `runs a setup command (${program} audit fix)`;
  }
  const action = program === 'find' ? tokens.find((token) => FIND_ACTIONS.has(token)) : undefined;
  if (action !== undefined) return `runs find ${action}, which changes files or runs commands`;
  if (program === 'mix' && words[0] === 'do') return mixTasksRefusal(tokens);
  const call = interpreterCall(tokens);
  if (call?.kind === 'inline') return 'runs inline code';
  if (call?.kind === 'module') return tokensRefusal(call.command);
  const refusal =
    taskRunnerRefusal(program, tokens) ??
    launcherRefusal(program, tokens) ??
    setupRefusal(program, tokens);
  if (refusal !== null) return refusal;
  const script = packageScript(tokens);
  if (
    script?.kind === 'package-script' &&
    script.manifest === 'package.json' &&
    APPLICATION_SCRIPTS.has(script.script)
  ) {
    return `runs the package script ${script.script}, which starts or stops the application and does not verify a change`;
  }
  const next = forwarded(tokens);
  if (next === null) return null;
  if ('refusal' in next) return next.refusal;
  for (const candidate of next.commands) {
    const refusal = tokensRefusal(candidate);
    if (refusal !== null) return refusal;
  }
  return null;
}

/**
 * Why SPLITBRIEF does not run a command the reviewer chose, or null when it runs. The policy
 * admits any installed program of any stack and refuses only what is not a verification: shell
 * syntax, programs run by path, inline code, downloads, setup commands and other command lines.
 */
export function reviewerCommandRefusal(command: string): string | null {
  return tokensRefusal(parseShellCommand(command));
}

/** The project file or files that define what a check runs. */
export type CheckDefinition =
  | { kind: 'script-file'; file: string }
  | {
      kind: 'package-script';
      runner: string;
      manifest: 'package.json' | 'composer.json';
      script: string;
      /** The directory a directory option names (`npm --prefix sub`), or `.`. */
      dir: string;
    }
  | { kind: 'task-file'; runner: string; files: readonly string[]; dirs: readonly string[] }
  | { kind: 'wrapper'; runner: string; files: readonly string[]; dirs: readonly string[] };

/** The directory the last directory option before `--` names, posix-normalized, or `.`. */
function directoryOf(runner: string, tokens: readonly string[]): string {
  const options = lookup(DIRECTORY_OPTIONS, runner) ?? [];
  let dir = '.';
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (token === '--') break;
    const name = token.replace(/=.*$/s, '');
    if (options.includes(name)) {
      dir = name === token ? (tokens[++index] ?? '.') : token.slice(name.length + 1);
    } else if (/^-[A-Za-z]./s.test(token) && options.includes(token.slice(0, 2))) {
      dir = token.slice(2);
    }
  }
  return posix.join(dir, '.');
}

/** The package script npm, pnpm, yarn, bun or composer runs, when the command runs one. */
function packageScript(tokens: readonly string[]): CheckDefinition | null {
  const runner = (tokens[0] ?? '').toLowerCase();
  const defined = (script: string | undefined): CheckDefinition | null =>
    script === undefined
      ? null
      : {
          kind: 'package-script',
          runner,
          manifest: runner === 'composer' ? 'composer.json' : 'package.json',
          script,
          dir: directoryOf(runner, tokens),
        };
  if (runner === 'npm' || runner === 'composer') {
    const [sub, name] = operands(tokens);
    if (sub === 'run' || sub === 'run-script') return defined(name);
    // `composer exec <program>` runs a program, not a script: the forwarded walk names it.
    if (runner === 'composer') {
      return sub !== undefined && handsOn(runner, sub) ? null : defined(sub);
    }
    if (sub === 'test' || sub === 't') return defined('test');
    return defined(sub !== undefined && APPLICATION_SCRIPTS.has(sub) ? sub : undefined);
  }
  if (runner !== 'pnpm' && runner !== 'yarn' && runner !== 'bun') return null;
  const word = packageManagerWord(tokens);
  if (word === null) return null;
  const script = tokens[word.index] ?? '';
  if (word.afterRun) return defined(script);
  // `bun test` and `bun build` are bun's own test runner and bundler; `bun run <name>` runs a script.
  if (script === 'test' || script === 't') return defined(runner === 'bun' ? undefined : 'test');
  if (runner === 'bun' && script === 'build') return null;
  if (APPLICATION_SCRIPTS.has(script)) return defined(script);
  if (PACKAGE_MANAGER_COMMANDS.has(script)) return null;
  // A bare word runs a program when one is installed under that name: `pnpm node scripts/x.js`.
  return definitionOf(tokens.slice(word.index)) ?? defined(script);
}

function definitionOf(tokens: readonly string[]): CheckDefinition | null {
  const call = interpreterCall(tokens);
  if (call?.kind === 'script') return { kind: 'script-file', file: posix.normalize(call.file) };
  if (call !== null) return null;
  const first = tokens[0] ?? '';
  const wrapper = projectWrapper(first);
  if (wrapper !== undefined) {
    return { kind: 'wrapper', runner: first, files: wrapper.files, dirs: wrapper.dirs };
  }
  const script = packageScript(tokens);
  if (script !== null) return script;
  const program = first.toLowerCase();
  const task = lookup(TASK_FILES, program);
  if (task !== undefined) return { kind: 'task-file', runner: program, ...task };
  const next = forwarded(tokens);
  if (next === null || 'refusal' in next) return null;
  for (const candidate of next.commands) {
    const definition = definitionOf(candidate);
    if (definition !== null) return definition;
  }
  return null;
}

/**
 * The project file or files that define what a command runs: an interpreter script, a package
 * script, a task file or a build wrapper, looking through `npx`, `bundle exec`, `uv run` and the
 * like. Null when the command runs none.
 */
export function checkDefinition(command: string): CheckDefinition | null {
  return definitionOf(parseShellCommand(command));
}

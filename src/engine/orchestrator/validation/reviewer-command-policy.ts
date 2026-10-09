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
    definition: [],
    valueLetters: 'DIjTtW',
  },
  gradle: {
    code: ['-I', '--init-script'],
    definition: [],
    valueLetters: null,
  },
  mix: { code: ['-e', '--eval'], definition: [], valueLetters: null },
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
  'Run an installed program by its name, never by path: `./mvnw`, `./gradlew` and `bin/test` are refused.',
  `A shell (${code(SHELLS)}) and a program that runs another command line (${code(WRAPPERS)}, \`npm explore\`) are refused. ${code(Object.entries(FORWARDERS).flatMap(([program, subs]) => subs.map((sub) => `${program} ${sub}`)))} and \`python -m\` are checked by the program they run. Forwarders may take options. Every non-option word after the subcommand is checked as a possible program start. \`uv run --with\` is refused because it downloads a package; \`mise exec\` runs only as \`mise exec -- <program>\`, because it installs the tools named before \`--\`. A first word that is not a command of \`pnpm\` or \`yarn\` is a script or program they run, and it is checked the same way (\`pnpm tsx\`, \`yarn node\`).`,
  `An interpreter, under any version of its name (\`python3.12\`, \`pypy3\`), runs a project script (\`python manage.py test\`, \`php artisan test\`) or a module (\`python -m pytest\`). It never runs inline code: \`node -e\`, \`python -c\`, \`deno eval\`, \`elixir -e\`, \`elixir --erl\`, \`iex -e\`, \`groovy -e\`, \`scala -e\`, \`kotlin -e\`, \`erl -eval\`, \`erl -s\`, \`erl -run\`, and \`php -r\`, \`php -B\`, \`php -R\`, \`php -F\`, \`php -E\` are refused. Interpreter option values are not code: \`perl -Mstrict t/x.t\`, \`php -c php.ini vendor/bin/phpunit\` and \`php -dmemory_limit=1G vendor/bin/phpunit\` can run. A build or task runner runs no inline code either: ${taskRunnerOptions('code')} are refused. So are ${code(Object.entries(TASK_CODE_GOALS).flatMap(([program, goals]) => goals.map((goal) => `${program} ${goal}${goal.endsWith(':') ? '*' : ''}`)))}, and \`mix do\` checks each task it chains as its own \`mix\` command. A \`make\` operand cannot set ${code(MAKE_CONTROL_VARIABLES)} or assign with \`!=\`.`,
  `\`npx\` runs only as \`npx --no-install <tool>\`, and \`npm exec\` only with \`--no-install\`; neither takes \`--yes\` or \`-y\`. A launcher that downloads and runs a package is refused: ${code(LAUNCHERS.map((pattern) => pattern.join(' ')))}, \`go run <package>@<version>\`.`,
  `A setup command is refused: a program whose subcommand or goal is ${code([...SETUP_VERBS].filter((verb) => SCOPED_SETUP_VERBS[verb] === undefined))} (\`npm ci\`, \`pip install\`, \`go generate\`, \`go mod tidy\`, \`mvn install\`), and a bare ${code(BARE_INSTALLERS)}. These setup verbs apply only to their named tools: ${code(Object.entries(SCOPED_SETUP_VERBS).flatMap(([verb, programs]) => programs.map((program) => `${program} ${verb}`)))}. \`npm run <script>\` and \`npm run-script <script>\` name package scripts, not setup verbs. A verification target such as \`make lock\` can run.`,
  `Package state commands are refused: ${code(Object.entries(PACKAGE_MUTATIONS).flatMap(([program, subs]) => subs.map((sub) => `${program} ${sub}`)))}. All forms of \`config\` and \`pkg\` are refused. An \`npm\`, \`pnpm\` or \`yarn\` \`audit\` with \`fix\` or \`--fix\` is refused; an audit without a fix can run.`,
  `\`find\` with ${code(FIND_ACTIONS)} is refused because it changes files or runs commands. Other \`find\` checks can run.`,
  `A program that does not verify a change is refused: ${code(NOT_VERIFICATION)}. ${code(
    Object.entries(TASK_RUNNERS)
      .filter(([, options]) => options.definition.length > 0)
      .map(([program]) => program),
  )} run only on the project's own task file, in its directory: ${taskRunnerOptions('definition')} are refused.`,
  'A package script, Makefile, justfile or interpreter script that this run changed is refused. A test file is not a check definition: a test this run wrote or changed runs (`node --test test/new.test.js`).',
];

function isFlag(token: string): boolean {
  return token.startsWith('-');
}

/** The words after the program that are not options, nor package manager option values. */
function operands(tokens: readonly string[]): string[] {
  const program = (tokens[0] ?? '').toLowerCase();
  const values =
    program === 'npm'
      ? NPM_VALUE_OPTIONS
      : program === 'pnpm' || program === 'yarn'
        ? PACKAGE_MANAGER_VALUE_OPTIONS
        : null;
  return tokens
    .slice(1)
    .filter((token, index) => !isFlag(token) && values?.has(tokens[index] ?? '') !== true);
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
  const subcommands = SUBCOMMAND_INTERPRETERS[program];
  if (!SCRIPT_INTERPRETERS.has(program) && subcommands === undefined) return null;
  const codeOptions = INTERPRETER_CODE_OPTIONS[program];
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
      if (VALUE_LETTERS[program]?.includes(letter) === true) {
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

/** The script or program pnpm or yarn runs when its first word is not one of its own commands. */
function packageManagerForwarded(tokens: readonly string[]): Forwarded | null {
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (isFlag(token)) {
      if (PACKAGE_MANAGER_VALUE_OPTIONS.has(token)) index++;
      continue;
    }
    const takes = PACKAGE_MANAGER_PREFIXES[token];
    if (takes !== undefined) {
      index += takes;
      continue;
    }
    return PACKAGE_MANAGER_COMMANDS.has(token) ? null : { commands: [tokens.slice(index)] };
  }
  return null;
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
  const subs = FORWARDERS[program] ?? [];
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
    commands: rest.flatMap((token, index) => {
      if (isFlag(token)) return [];
      // hatch runs `<environment>:<command>` in that environment.
      const first = program === 'hatch' ? token.slice(token.lastIndexOf(':') + 1) : token;
      return [[first, ...rest.slice(index + 1)]];
    }),
  };
}

function setupRefusal(program: string, tokens: readonly string[]): string | null {
  const words = operands(tokens);
  if (words.length === 0) {
    return BARE_INSTALLERS.has(program) ? `runs ${program} with no argument, which installs` : null;
  }
  const checked = GOAL_RUNNERS.has(program)
    ? words
    : COMMAND_GROUPS.has(words[0] ?? '')
      ? words.slice(0, 2)
      : words.slice(0, 1);
  const at = checked.findIndex(
    (word) =>
      SETUP_VERBS.has(word) &&
      (SCOPED_SETUP_VERBS[word] === undefined || SCOPED_SETUP_VERBS[word].includes(program)),
  );
  if (at === -1) return null;
  const named = GOAL_RUNNERS.has(program) ? checked.slice(at, at + 1) : checked.slice(0, at + 1);
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
  const runner = TASK_RUNNERS[program];
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
  const goals = TASK_CODE_GOALS[program];
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
  const mutation = PACKAGE_MUTATIONS[program]?.find((sub) => words[0] === sub);
  if (mutation !== undefined) return `runs ${program} ${mutation}, which changes package state`;
  if (
    PACKAGE_MUTATIONS[program] !== undefined &&
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

/**
 * The project script a command runs through an interpreter, relative to the run workspace, looking
 * through `npx`, `bundle exec`, `uv run` and the like. Null when it runs no script file.
 */
export function interpreterScript(command: string): string | null {
  function script(tokens: readonly string[]): string | null {
    const call = interpreterCall(tokens);
    if (call?.kind === 'script') return posix.normalize(call.file);
    if (call !== null) return null;
    const next = forwarded(tokens);
    if (next === null || 'refusal' in next) return null;
    for (const candidate of next.commands) {
      const file = script(candidate);
      if (file !== null) return file;
    }
    return null;
  }
  return script(parseShellCommand(command));
}

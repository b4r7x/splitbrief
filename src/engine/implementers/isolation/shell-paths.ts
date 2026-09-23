import { basename, join, resolve, sep } from 'node:path';
import { HOME_MARK, lexShell, OPAQUE, PWD_MARK, TMPDIR_MARK } from './shell-lexer.js';

export type PathAccess = 'read' | 'list' | 'search' | 'write';

/**
 * One place a tool use reaches: absolute and lexically resolved, with how it is
 * reached. `followsLink` is false where the command acts on the name itself —
 * `rm node_modules` removes the link, it does not reach through it. `mentioned`
 * marks a word only guessed to be a path — an operand of a command this reading
 * does not know, like the test name in `vitest -t /api/users` — which reaches
 * something only if it exists.
 */
export type PathReference = Readonly<{
  path: string;
  access: PathAccess;
  followsLink: boolean;
  mentioned?: boolean | undefined;
  /** The write a package-manager install, ci, add, remove or update makes to `node_modules`. */
  changesPackages?: boolean | undefined;
}>;

/** What `~`, `$HOME`, `$TMPDIR` and a relative path mean for the process that runs the command. */
export type PathScope = Readonly<{ cwd: string; home: string; tmpdir: string | undefined }>;

// A substitution, an unknown variable or a glob ends what a word says for certain.
const UNCERTAIN = [OPAQUE, '*', '?', '[', '{'];
const MAX_NESTING = 8;

type ParsedArgs = {
  positionals: string[];
  flags: Set<string>;
  values: { option: string; value: string }[];
};

type ArgSpec = Readonly<{
  /** Short options that take a value, attached (`-fFILE`) or as the next word. */
  short?: string;
  /** Long options that take the next word as their value; `--name=value` needs no listing. */
  long?: readonly string[];
  /** Options end at the first operand — a wrapper's operand is the command it runs. */
  stopAtOperand?: boolean;
}>;

function parseArgs(args: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: new Set(), values: [] };
  let index = 0;
  for (let arg = args[index]; arg !== undefined; arg = args[index]) {
    index += 1;
    if (arg === '--') {
      parsed.positionals.push(...args.slice(index));
      break;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const option = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      parsed.flags.add(option);
      if (equals !== -1) parsed.values.push({ option, value: arg.slice(equals + 1) });
      else if (spec.long?.includes(option) === true) {
        const value = args[index];
        if (value !== undefined) parsed.values.push({ option, value });
        index += 1;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const option = arg.charAt(at);
        parsed.flags.add(option);
        if (spec.short?.includes(option) !== true) continue;
        const attached = arg.slice(at + 1);
        const next = args[index];
        if (attached !== '') parsed.values.push({ option, value: attached });
        else if (next !== undefined) {
          parsed.values.push({ option, value: next });
          index += 1;
        }
        break;
      }
    } else {
      parsed.positionals.push(arg);
      if (spec.stopAtOperand === true) {
        parsed.positionals.push(...args.slice(index));
        break;
      }
    }
  }
  return parsed;
}

function valuesOf(parsed: ParsedArgs, ...options: string[]): string[] {
  return parsed.values
    .filter((entry) => options.includes(entry.option))
    .map((entry) => entry.value);
}

function hasFlag(parsed: ParsedArgs, ...flags: string[]): boolean {
  return flags.some((flag) => parsed.flags.has(flag));
}

type ShellContext = {
  /** The directory the command runs in, shared with the commands after it. */
  state: { cwd: string };
  chdir: (word: string) => void;
  add: (word: string, access: PathAccess, followsLink?: boolean) => void;
  /** A word that may or may not be a path: an unknown command's operand. */
  mention: (word: string) => void;
  /** A package-manager install, ci, add, remove or update run from `dir`. */
  changesPackages: (dir: string) => void;
  /** Another command line's words, run from here: `xargs rm`, `find -exec`, `sudo cat`. */
  words: (argv: readonly string[]) => void;
  /** A script this one hands to another shell: `bash -c`, `npx -c`. */
  script: (source: string) => void;
};

type Handler = (args: readonly string[], ctx: ShellContext) => void;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that open or continue a compound command; the command itself follows them. */
const LEADING_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'do',
  'while',
  'until',
  '!',
  '{',
  '}',
]);

/** An unknown command reads what it is given; an option's `=value` and a `NAME=value` operand too. */
const readsArguments: Handler = (args, ctx) => {
  for (const arg of args) {
    const equals = arg.indexOf('=');
    if (arg.startsWith('-')) {
      if (equals !== -1) ctx.mention(arg.slice(equals + 1));
    } else if (ASSIGNMENT.test(arg)) {
      ctx.mention(arg.slice(equals + 1));
    } else {
      ctx.mention(arg);
    }
  }
};

/** `cat`, `head`, `wc`: every operand is a file the command reads. */
function readsFiles(short: string): Handler {
  return (args, ctx) => {
    for (const operand of parseArgs(args, { short }).positionals) ctx.add(operand, 'read');
  };
}

const ignoresArguments: Handler = () => undefined;

const changeDirectory: Handler = (args, ctx) => {
  const target = args.find((arg) => !arg.startsWith('-') || arg === '-') ?? HOME_MARK;
  if (target === '-') return;
  ctx.add(target, 'read');
  ctx.chdir(target);
};

const listing: Handler = (args, ctx) => {
  const parsed = parseArgs(args, { short: 'IwT', long: ['ignore', 'width', 'tabsize'] });
  const access = hasFlag(parsed, 'R', 'recursive') ? 'search' : 'list';
  for (const path of parsed.positionals) ctx.add(path, access);
};

const searchesArguments: Handler = (args, ctx) => {
  const parsed = parseArgs(args, { short: 'dLPIoBtX', long: ['max-depth', 'exclude'] });
  if (parsed.positionals.length === 0) ctx.add('.', 'search');
  for (const path of parsed.positionals) ctx.add(path, 'search');
};

const GREP_VALUES = [
  'regexp',
  'file',
  'max-count',
  'after-context',
  'before-context',
  'context',
  'include',
  'exclude',
  'exclude-dir',
  'glob',
  'iglob',
  'type',
  'type-not',
  'max-depth',
  'replace',
];

/** `grep`'s first operand is its pattern unless `-e` or `-f` supplied one; the rest are paths. */
function grepFamily(
  short: string,
  { recursiveByDefault }: { recursiveByDefault: boolean },
): Handler {
  return (args, ctx) => {
    const parsed = parseArgs(args, { short, long: GREP_VALUES });
    for (const file of valuesOf(parsed, 'f', 'file')) ctx.add(file, 'read');
    const patternGiven = valuesOf(parsed, 'e', 'f', 'regexp', 'file').length > 0;
    const paths = patternGiven ? parsed.positionals : parsed.positionals.slice(1);
    const recursive =
      recursiveByDefault || hasFlag(parsed, 'r', 'R', 'recursive', 'dereference-recursive');
    if (paths.length === 0 && recursive) ctx.add('.', 'search');
    for (const path of paths) ctx.add(path, recursive ? 'search' : 'read');
  };
}

const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

const find: Handler = (args, ctx) => {
  let index = 0;
  while (/^-(?:[HLP]|O\d*|D)$/.test(args[index] ?? '')) {
    index += args[index] === '-D' ? 2 : 1;
  }
  const roots: string[] = [];
  for (let arg = args[index]; arg !== undefined; arg = args[index]) {
    if (arg.startsWith('-') || arg === '(' || arg === '!') break;
    roots.push(arg);
    index += 1;
  }
  const expression = args.slice(index);
  const access = expression.includes('-delete') ? 'write' : 'search';
  for (const root of roots.length === 0 ? ['.'] : roots) ctx.add(root, access);
  for (let at = 0; at < expression.length; at += 1) {
    if (!FIND_EXEC_ACTIONS.has(expression[at] ?? '')) continue;
    const close = expression.findIndex(
      (word, position) => position > at && (word === ';' || word === '+'),
    );
    const end = close === -1 ? expression.length : close;
    ctx.words(expression.slice(at + 1, end));
    at = end;
  }
};

/** `sed` and `awk` take their program as the first operand unless an option supplied it. */
function scripted(
  short: string,
  { programOptions, inPlace }: { programOptions: readonly string[]; inPlace: readonly string[] },
): Handler {
  return (args, ctx) => {
    const parsed = parseArgs(args, { short, long: ['expression', 'file', 'assign'] });
    for (const file of valuesOf(parsed, 'f', 'file')) ctx.add(file, 'read');
    // BSD `sed -i ''` spells an empty backup suffix as its own word.
    const operands = parsed.positionals.filter((operand) => operand !== '');
    const programGiven = valuesOf(parsed, ...programOptions).length > 0;
    const access = inPlace.some((flag) => parsed.flags.has(flag)) ? 'write' : 'read';
    for (const file of programGiven ? operands : operands.slice(1)) ctx.add(file, access);
  };
}

function interpreter(short: string, long: readonly string[] = []): Handler {
  return (args, ctx) => {
    const parsed = parseArgs(args, { short, long, stopAtOperand: true });
    readsArguments(parsed.positionals, ctx);
  };
}

/** `cp a b`: the last operand is written, the others are read. */
const copies: Handler = (args, ctx) => {
  const parsed = parseArgs(args, { short: 'tS', long: ['target-directory'] });
  const targets = valuesOf(parsed, 't', 'target-directory');
  const last = targets.length > 0 ? -1 : parsed.positionals.length - 1;
  for (const target of targets) ctx.add(target, 'write');
  for (const [index, operand] of parsed.positionals.entries()) {
    ctx.add(operand, index === last && last > 0 ? 'write' : 'read');
  }
};

/** `rm`, `mv`: the command acts on the name, so a trailing slash is what reaches through a link. */
function removes(short: string): Handler {
  return (args, ctx) => {
    const parsed = parseArgs(args, { short, long: ['target-directory'] });
    for (const target of valuesOf(parsed, 't', 'target-directory')) ctx.add(target, 'write');
    for (const operand of parsed.positionals) ctx.add(operand, 'write', operand.endsWith('/'));
  };
}

function writes(short: string): Handler {
  return (args, ctx) => {
    for (const operand of parseArgs(args, { short }).positionals) ctx.add(operand, 'write');
  };
}

/**
 * `git -C <dir>` points every later argument at another repository; the
 * repository itself is only named, since what git does there depends on the
 * subcommand. A commit message is text, and `git grep` searches the repository
 * it runs in.
 */
const git: Handler = (args, ctx) => {
  const outer = ctx.state.cwd;
  let index = 0;
  for (let arg = args[index]; arg?.startsWith('-') === true; arg = args[index]) {
    const value = args[index + 1];
    if (arg === '-C' && value !== undefined) {
      ctx.add(value, 'read');
      ctx.chdir(value);
      index += 2;
    } else if ((arg === '--git-dir' || arg === '--work-tree') && value !== undefined) {
      ctx.add(value, 'read');
      index += 2;
    } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      ctx.add(arg.slice(arg.indexOf('=') + 1), 'read');
      index += 1;
    } else {
      index += arg === '-c' || arg === '--namespace' ? 2 : 1;
    }
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  const parsed = parseArgs(rest, {
    short: 'mFbBc',
    long: ['message', 'file', 'branch', 'author', 'format', 'pretty', 'grep', 'template'],
  });
  if (subcommand === 'clone') {
    const [source, target] = parsed.positionals;
    if (source !== undefined) ctx.add(source, 'read');
    if (target !== undefined) ctx.add(target, 'write');
  } else if (subcommand === 'worktree' && parsed.positionals[0] === 'add') {
    const target = parsed.positionals[1];
    if (target !== undefined) ctx.add(target, 'write');
  } else if (subcommand !== 'grep') {
    for (const operand of parsed.positionals) ctx.add(operand, 'read');
  }
  ctx.state.cwd = outer;
};

/**
 * The package-manager verbs the implementer prompt forbids — install, ci, add,
 * remove, update — with their aliases. The isolation directory's `node_modules`
 * is a link into the checkout, so running one there changes the checkout's
 * installed packages.
 */
const PACKAGE_CHANGES: ReadonlySet<string> = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
]);

const PACKAGE_RUNNERS = new Set(['exec', 'x', 'dlx']);

function packageManager(manager: 'npm' | 'pnpm' | 'yarn' | 'bun'): Handler {
  return (args, ctx) => {
    const parsed = parseArgs(args, {
      short: 'Cw',
      long: ['prefix', 'dir', 'cwd', 'filter', 'workspace', 'registry', 'cache', 'loglevel'],
    });
    const [subcommand, ...operands] = parsed.positionals;
    if (subcommand !== undefined && PACKAGE_RUNNERS.has(subcommand)) {
      ctx.words(operands);
      return;
    }
    const target = valuesOf(parsed, 'prefix', 'dir', 'cwd', 'C').at(-1) ?? '.';
    if (target !== '.') ctx.add(target, 'read');
    // A bare `yarn` installs; a global install writes to the tool's own prefix, which this
    // reading cannot name.
    const changes = subcommand === undefined ? manager === 'yarn' : PACKAGE_CHANGES.has(subcommand);
    if (changes && !hasFlag(parsed, 'g', 'global')) ctx.changesPackages(target);
    for (const operand of operands) ctx.mention(operand);
  };
}

const runsPackage: Handler = (args, ctx) => {
  const parsed = parseArgs(args, { short: 'pc', long: ['package', 'call'], stopAtOperand: true });
  for (const call of valuesOf(parsed, 'c', 'call')) ctx.script(call);
  ctx.words(parsed.positionals);
};

const shell: Handler = (args, ctx) => {
  const parsed = parseArgs(args, {
    short: 'oO',
    long: ['rcfile', 'init-file'],
    stopAtOperand: true,
  });
  const [first, ...rest] = parsed.positionals;
  if (first === undefined) return;
  if (parsed.flags.has('c')) {
    ctx.script(first);
    return;
  }
  ctx.add(first, 'read');
  readsArguments(rest, ctx);
};

/** `xargs`, `sudo`, `env`: the operand is another command, run with the same working directory. */
function wrapper(short: string): Handler {
  return (args, ctx) => {
    ctx.words(parseArgs(args, { short, stopAtOperand: true }).positionals);
  };
}

const NO_PATH_COMMANDS = [
  ':',
  '[',
  '[[',
  'alias',
  'basename',
  'clear',
  'date',
  'declare',
  'dirname',
  'echo',
  'exit',
  'export',
  'expr',
  'false',
  'hash',
  'history',
  'hostname',
  'id',
  'jobs',
  'kill',
  'let',
  'local',
  'pgrep',
  'pkill',
  'printenv',
  'printf',
  'ps',
  'pwd',
  'read',
  'readonly',
  'return',
  'seq',
  'set',
  'shift',
  'sleep',
  'test',
  'tput',
  'trap',
  'true',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'uname',
  'unset',
  'wait',
  'which',
  'whoami',
  'yes',
];

const COMMANDS: Readonly<Record<string, Handler>> = {
  ...Object.fromEntries(NO_PATH_COMMANDS.map((name) => [name, ignoresArguments])),
  cd: changeDirectory,
  pushd: changeDirectory,
  ls: listing,
  cat: readsFiles(''),
  head: readsFiles('nc'),
  tail: readsFiles('nc'),
  wc: readsFiles(''),
  tree: searchesArguments,
  grep: grepFamily('efmABCdD', { recursiveByDefault: false }),
  rg: grepFamily('efgtTmABCjMr', { recursiveByDefault: true }),
  find,
  sed: scripted('efl', {
    programOptions: ['e', 'f', 'expression', 'file'],
    inPlace: ['i', 'in-place'],
  }),
  awk: scripted('fvF', { programOptions: ['f', 'file'], inPlace: [] }),
  node: interpreter('epr', ['eval', 'print', 'require', 'import', 'loader', 'input-type']),
  tsx: interpreter('epr', ['eval', 'print', 'require', 'import']),
  python: interpreter('cmWXQ'),
  python3: interpreter('cmWXQ'),
  cp: copies,
  mv: removes('tS'),
  rm: removes(''),
  touch: writes('rtdA'),
  mkdir: writes('m'),
  tee: writes(''),
  git,
  npm: packageManager('npm'),
  pnpm: packageManager('pnpm'),
  yarn: packageManager('yarn'),
  bun: packageManager('bun'),
  npx: runsPackage,
  pnpx: runsPackage,
  bunx: runsPackage,
  bash: shell,
  sh: shell,
  zsh: shell,
  xargs: wrapper('ILnPsdEa'),
  sudo: wrapper('ugCDhpRrTU'),
  env: wrapper('uS'),
};

function resolveWord(word: string, scope: PathScope, cwd: string): string | null {
  const text = word
    .replaceAll(HOME_MARK, scope.home)
    .replaceAll(PWD_MARK, cwd)
    .replaceAll(TMPDIR_MARK, scope.tmpdir ?? OPAQUE);
  const cut = Math.min(
    ...UNCERTAIN.map((marker) => text.indexOf(marker)).filter((at) => at !== -1),
    text.length,
  );
  const certain = text.slice(0, cut);
  if (certain === '' || certain.startsWith('-') || certain.includes('://')) return null;
  return resolve(cwd, certain);
}

function analyzeWords(
  words: readonly string[],
  scope: PathScope,
  state: { cwd: string },
  out: PathReference[],
  depth: number,
): void {
  const start = words.findIndex((word) => !ASSIGNMENT.test(word) && !LEADING_KEYWORDS.has(word));
  if (start === -1) return;
  const [name, ...args] = words.slice(start);
  if (name === undefined) return;
  const ctx: ShellContext = {
    state,
    chdir: (word) => {
      state.cwd = resolveWord(word, scope, state.cwd) ?? state.cwd;
    },
    add: (word, access, followsLink = true) => {
      const path = resolveWord(word, scope, state.cwd);
      // A word cut at a glob names what the glob expands under: `rm -rf node_modules/*`
      // empties the directory the link points at, not the link.
      const cut = UNCERTAIN.some((marker) => word.includes(marker));
      if (path !== null) out.push({ path, access, followsLink: followsLink || cut });
    },
    mention: (word) => {
      const path = resolveWord(word, scope, state.cwd);
      // A lone `/` is a delimiter far more often than the root: `cut -d /`, `tr / _`.
      if (path !== null && path !== sep) {
        out.push({ path, access: 'read', followsLink: true, mentioned: true });
      }
    },
    changesPackages: (dir) => {
      const path = resolveWord(join(dir, 'node_modules'), scope, state.cwd);
      if (path !== null) {
        out.push({ path, access: 'write', followsLink: true, changesPackages: true });
      }
    },
    words: (argv) => {
      if (depth < MAX_NESTING) analyzeWords(argv, scope, state, out, depth + 1);
    },
    script: (source) => {
      if (depth < MAX_NESTING) collect(source, { ...scope, cwd: state.cwd }, out, depth + 1);
    },
  };
  if (name.includes('/')) ctx.mention(name);
  (COMMANDS[basename(name)] ?? readsArguments)(args, ctx);
}

/** Reads `source` into `out`; returns the working directory the script leaves its shell in. */
function collect(source: string, scope: PathScope, out: PathReference[], depth: number): string {
  const { commands, nested } = lexShell(source);
  const state = { cwd: scope.cwd };
  for (const command of commands) {
    for (const redirect of command.redirects) {
      const path = resolveWord(redirect.target, scope, state.cwd);
      if (path !== null) out.push({ path, access: redirect.access, followsLink: true });
    }
    analyzeWords(command.words, scope, state, out, depth);
  }
  for (const inner of nested) {
    if (depth < MAX_NESTING) collect(inner, scope, out, depth + 1);
  }
  return state.cwd;
}

/** What a command line reaches, and the directory its shell is left in for the next one. */
export type ShellReading = Readonly<{ references: PathReference[]; cwd: string }>;

/**
 * Every path a shell command line names, with how the command reaches it, and
 * the directory a `cd` in it leaves the shell in.
 * Only what the line says for certain counts: a glob, a substitution or an
 * unknown variable ends a word, so `/Users/me/*` reaches `/Users/me` and
 * `$(pwd)/x` reaches nothing this reading can name.
 */
export function readShellCommand(command: string, scope: PathScope): ShellReading {
  const references: PathReference[] = [];
  const cwd = collect(command, scope, references, 0);
  return { references, cwd };
}

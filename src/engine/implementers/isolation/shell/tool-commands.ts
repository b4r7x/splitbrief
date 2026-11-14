import { parseArgs, valuesOf, hasFlag } from './args.js';
import { readsArguments } from './file-commands.js';
import type { Handler } from './types.js';

/**
 * `git -C <dir>` points every later argument at another repository; the
 * repository itself is only named, since what git does there depends on the
 * subcommand. A commit message is text, and `git grep` searches the repository
 * it runs in.
 */
export const git: Handler = (args, ctx) => {
  const outer = ctx.state.cwd;
  let index = 0;
  for (let arg = args[index]; arg?.startsWith('-') === true; arg = args[index]) {
    const value = args[index + 1];
    if (arg === '-C' && value !== undefined) {
      ctx.chdir(value, 'through-links');
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

export function packageManager(manager: 'npm' | 'pnpm' | 'yarn' | 'bun'): Handler {
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

export const runsPackage: Handler = (args, ctx) => {
  const parsed = parseArgs(args, { short: 'pc', long: ['package', 'call'], stopAtOperand: true });
  for (const call of valuesOf(parsed, 'c', 'call')) ctx.script(call);
  ctx.words(parsed.positionals);
};

export const shell: Handler = (args, ctx) => {
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
export function wrapper(short: string): Handler {
  return (args, ctx) => {
    ctx.words(parseArgs(args, { short, stopAtOperand: true }).positionals);
  };
}

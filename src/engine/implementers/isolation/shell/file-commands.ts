import { ASSIGNMENT, parseArgs, hasFlag, valuesOf } from './args.js';
import { HOME_MARK } from './lexer.js';
import type { Handler } from './types.js';

/** An unknown command reads what it is given; an option's `=value` and a `NAME=value` operand too. */
export const readsArguments: Handler = (args, ctx) => {
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
export function readsFiles(short: string): Handler {
  return (args, ctx) => {
    for (const operand of parseArgs(args, { short }).positionals) ctx.add(operand, 'read');
  };
}

export const ignoresArguments: Handler = () => undefined;

export const changeDirectory: Handler = (args, ctx) => {
  const target = args.find((arg) => !arg.startsWith('-') || arg === '-') ?? HOME_MARK;
  if (target === '-') return;
  ctx.chdir(target, args.includes('-P') ? 'through-links' : 'by-name');
};

export const listing: Handler = (args, ctx) => {
  const parsed = parseArgs(args, { short: 'IwT', long: ['ignore', 'width', 'tabsize'] });
  const access = hasFlag(parsed, 'R', 'recursive') ? 'search' : 'list';
  for (const path of parsed.positionals) ctx.add(path, access);
};

export const searchesArguments: Handler = (args, ctx) => {
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
export function grepFamily(
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

export const find: Handler = (args, ctx) => {
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
export function scripted(
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

export function interpreter(short: string, long: readonly string[] = []): Handler {
  return (args, ctx) => {
    const parsed = parseArgs(args, { short, long, stopAtOperand: true });
    readsArguments(parsed.positionals, ctx);
  };
}

/** `cp a b`: the last operand is written, the others are read. */
export const copies: Handler = (args, ctx) => {
  const parsed = parseArgs(args, { short: 'tS', long: ['target-directory'] });
  const targets = valuesOf(parsed, 't', 'target-directory');
  const last = targets.length > 0 ? -1 : parsed.positionals.length - 1;
  for (const target of targets) ctx.add(target, 'write');
  for (const [index, operand] of parsed.positionals.entries()) {
    ctx.add(operand, index === last && last > 0 ? 'write' : 'read');
  }
};

/** `rm`, `mv`: the command acts on the name, so a trailing slash is what reaches through a link. */
export function removes(short: string): Handler {
  return (args, ctx) => {
    const parsed = parseArgs(args, { short, long: ['target-directory'] });
    for (const target of valuesOf(parsed, 't', 'target-directory')) ctx.add(target, 'write');
    for (const operand of parsed.positionals) ctx.add(operand, 'write', operand.endsWith('/'));
  };
}

export function writes(short: string): Handler {
  return (args, ctx) => {
    for (const operand of parseArgs(args, { short }).positionals) ctx.add(operand, 'write');
  };
}

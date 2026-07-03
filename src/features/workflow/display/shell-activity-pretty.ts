export interface PrettyShellActivity {
  label: 'READ' | 'FIND' | 'LIST';
  value: string;
}

const COMPOUND_COMMAND_PATTERN = /&&|\|\||[|;<>]|\$\(/;
const SED_RANGE_PATTERN = /^(\d+),(\d+)p$/;
const COUNT_PATTERN = /^\d+$/;
const HEAD_TAIL_COUNT_FLAG_PATTERN = /^-n?\d+$/;
const RG_GREP_VALUED_FLAGS: ReadonlySet<string> = new Set([
  '-A',
  '-B',
  '-C',
  '-m',
  '-g',
  '-t',
  '-T',
  '-e',
  '-f',
  '--context',
  '--after-context',
  '--before-context',
  '--max-count',
  '--glob',
  '--iglob',
  '--type',
  '--type-not',
  '--type-add',
  '--regexp',
  '--file',
  '--include',
  '--exclude',
  '--exclude-dir',
  '--sort',
  '--sortr',
  '-j',
  '-M',
  '--max-columns',
  '--threads',
  '--engine',
  '--colors',
  '-d',
  '-D',
]);
const RG_GREP_EMBEDDED_PATTERN_FLAGS = ['--regexp=', '--file='];
const RG_GREP_RAW_FLAGS: ReadonlySet<string> = new Set(['--files']);
const LS_VALUED_FLAGS: ReadonlySet<string> = new Set([
  '-w',
  '-I',
  '-T',
  '--sort',
  '--time',
  '--format',
  '--width',
  '--block-size',
  '--ignore',
  '--hide',
  '--quoting-style',
  '--color',
  '--tab-size',
]);

// Conservative shell-command prettifier: recognizes the handful of read/search/list shapes CLI
// runners emit constantly; anything compound or ambiguous returns null and stays a raw RUN.
export function prettifyShellActivity(command: string): PrettyShellActivity | null {
  if (COMPOUND_COMMAND_PATTERN.test(command)) return null;
  const tokens = tokenizeShellCommand(command.trim());
  if (tokens === null) return null;
  const [name, ...args] = tokens;
  switch (name) {
    case 'sed':
      return prettifySed(args);
    case 'cat':
      return prettifyCat(args);
    case 'head':
    case 'tail':
      return prettifyHeadTail(args);
    case 'rg':
    case 'grep':
      return prettifyGrep(args);
    case 'ls':
      return prettifyLs(args);
    default:
      return null;
  }
}

function prettifySed(args: string[]): PrettyShellActivity | null {
  if (args.length !== 3 || args[0] !== '-n') return null;
  const range = SED_RANGE_PATTERN.exec(unquote(args[1] ?? ''));
  const start = range?.[1];
  const end = range?.[2];
  const file = args[2];
  if (start === undefined || end === undefined || file === undefined || isFlag(file)) return null;
  return { label: 'READ', value: `${unquote(file)} :${start}-${end}` };
}

function prettifyCat(args: string[]): PrettyShellActivity | null {
  const files = args.filter((arg) => !isFlag(arg));
  const file = files[0];
  if (files.length !== 1 || file === undefined) return null;
  return { label: 'READ', value: unquote(file) };
}

function prettifyHeadTail(args: string[]): PrettyShellActivity | null {
  if (args.length === 3 && args[0] === '-n' && COUNT_PATTERN.test(args[1] ?? '')) {
    const file = args[2];
    if (file === undefined || isFlag(file)) return null;
    return { label: 'READ', value: unquote(file) };
  }
  if (args.length === 2 && HEAD_TAIL_COUNT_FLAG_PATTERN.test(args[0] ?? '')) {
    const file = args[1];
    if (file === undefined || isFlag(file)) return null;
    return { label: 'READ', value: unquote(file) };
  }
  return null;
}

function prettifyGrep(args: string[]): PrettyShellActivity | null {
  if (
    hasSeparatedValuedFlag(args, RG_GREP_VALUED_FLAGS) ||
    args.some((arg) => RG_GREP_RAW_FLAGS.has(arg)) ||
    hasEmbeddedPatternFlag(args, RG_GREP_EMBEDDED_PATTERN_FLAGS)
  ) {
    return null;
  }
  const positional: string[] = [];
  for (const arg of args) {
    if (isFlag(arg)) {
      continue;
    }
    positional.push(arg);
  }
  const [pattern, ...paths] = positional;
  if (pattern === undefined) return null;
  const quotedPattern = `"${unquote(pattern)}"`;
  if (paths.length === 0) return { label: 'FIND', value: quotedPattern };
  return { label: 'FIND', value: `${quotedPattern}  ${paths.map(unquote).join(' ')}` };
}

function prettifyLs(args: string[]): PrettyShellActivity | null {
  if (hasSeparatedValuedFlag(args, LS_VALUED_FLAGS)) return null;
  const paths = args.filter((arg) => !isFlag(arg));
  if (paths.length > 1) return null;
  const path = paths[0];
  return { label: 'LIST', value: path === undefined ? '.' : unquote(path) };
}

function hasSeparatedValuedFlag(args: string[], valuedFlags: ReadonlySet<string>): boolean {
  return args.some((arg) => valuedFlags.has(arg));
}

function hasEmbeddedPatternFlag(args: string[], prefixes: readonly string[]): boolean {
  return args.some((arg) => prefixes.some((prefix) => arg.startsWith(prefix)));
}

function isFlag(token: string): boolean {
  return token.startsWith('-');
}

function unquote(token: string): string {
  const first = token[0];
  if ((first === "'" || first === '"') && token.length >= 2 && token.endsWith(first)) {
    return token.slice(1, -1);
  }
  return token;
}

function tokenizeShellCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote !== null) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

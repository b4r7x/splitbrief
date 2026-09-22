import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { executableName } from './interpreter-command-string.js';

/**
 * The command a wrapper runs, with the environment assignments `env` adds for it and the
 * values of the wrapper's own options.
 */
export type WrappedCommand = Readonly<{
  assignments: readonly string[];
  optionValues: readonly string[];
  argv: readonly string[];
}>;

type WrapperGrammar = Readonly<{
  flags: readonly string[];
  valued: readonly string[];
  operands: number;
}>;

const WRAPPERS = new Map<string, WrapperGrammar>([
  ['command', { flags: ['-p', '-v', '-V'], valued: [], operands: 0 }],
  ['exec', { flags: ['-c', '-l', '-cl', '-lc'], valued: ['-a'], operands: 0 }],
  ['nice', { flags: [], valued: ['-n', '--adjustment'], operands: 0 }],
  ['nohup', { flags: [], valued: [], operands: 0 }],
  [
    'stdbuf',
    { flags: [], valued: ['-i', '-o', '-e', '--input', '--output', '--error'], operands: 0 },
  ],
  [
    'time',
    {
      flags: ['-a', '-l', '-p', '-q', '-v', '--append', '--portability', '--quiet', '--verbose'],
      valued: ['-f', '-o', '--format', '--output'],
      operands: 0,
    },
  ],
  [
    'timeout',
    {
      flags: ['-v', '--foreground', '--preserve-status', '--verbose'],
      valued: ['-k', '-s', '--kill-after', '--signal'],
      operands: 1,
    },
  ],
]);

const ENV_FLAGS = new Set([
  '-',
  '--debug',
  '--help',
  '--ignore-environment',
  '--list-signal-handling',
  '--null',
  '--version',
]);
const ENV_SIGNAL_OPTIONS = ['--block-signal', '--default-signal', '--ignore-signal'];
const ENV_CLUSTER_FLAGS = new Set(['0', 'i', 'v']);

function attachedValue(arg: string, option: string): string | null {
  const prefix = option.startsWith('--') ? `${option}=` : option;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}

function unwrapByGrammar(
  grammar: WrapperGrammar,
  args: readonly string[],
): WrappedCommand | 'opaque' {
  const optionValues: string[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    if (grammar.flags.includes(arg) || /^-\d+$/.test(arg)) continue;
    if (grammar.valued.includes(arg)) {
      optionValues.push(args[++index] ?? '');
      continue;
    }
    const attached = grammar.valued
      .map((option) => attachedValue(arg, option))
      .find((value): value is string => value !== null);
    if (attached === undefined) return 'opaque';
    optionValues.push(attached);
  }
  return {
    assignments: [],
    optionValues: [...optionValues, ...args.slice(index, index + grammar.operands)],
    argv: args.slice(index + grammar.operands),
  };
}

function envCommand(args: readonly string[], optionValues: readonly string[]): WrappedCommand {
  let index = 0;
  while (index < args.length && (args[index] ?? '').includes('=')) index += 1;
  return { assignments: args.slice(0, index), optionValues, argv: args.slice(index) };
}

/**
 * `env -S` splits its string into further arguments. Only plain words and simple quotes are
 * split here; escapes, `${...}` expansion and comments leave the command opaque.
 */
function unwrapSplitString(
  value: string | undefined,
  rest: readonly string[],
  optionValues: readonly string[],
): WrappedCommand | 'opaque' {
  if (value === undefined || /[\\$#]/.test(value)) return 'opaque';
  const inner = unwrapEnv([...parseShellCommand(value), ...rest]);
  return inner === 'opaque'
    ? inner
    : { ...inner, optionValues: [...optionValues, ...inner.optionValues] };
}

function unwrapEnv(args: readonly string[]): WrappedCommand | 'opaque' {
  const optionValues: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--') return envCommand(args.slice(index + 1), optionValues);
    if (!arg.startsWith('-')) return envCommand(args.slice(index), optionValues);
    if (ENV_FLAGS.has(arg)) continue;
    if (ENV_SIGNAL_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`))) {
      continue;
    }
    if (arg === '--unset') {
      optionValues.push(args[++index] ?? '');
      continue;
    }
    if (arg.startsWith('--unset=')) {
      optionValues.push(arg.slice('--unset='.length));
      continue;
    }
    if (arg === '--split-string') {
      return unwrapSplitString(args[index + 1], args.slice(index + 2), optionValues);
    }
    if (arg.startsWith('--split-string=')) {
      const value = arg.slice('--split-string='.length);
      return unwrapSplitString(value, args.slice(index + 1), optionValues);
    }
    if (arg.startsWith('--')) return 'opaque';
    for (let at = 1; at < arg.length; at += 1) {
      const letter = arg.charAt(at);
      if (ENV_CLUSTER_FLAGS.has(letter)) continue;
      const attached = arg.slice(at + 1);
      if (letter === 'S') {
        return attached === ''
          ? unwrapSplitString(args[index + 1], args.slice(index + 2), optionValues)
          : unwrapSplitString(attached, args.slice(index + 1), optionValues);
      }
      if (letter !== 'u') return 'opaque';
      optionValues.push(attached === '' ? (args[++index] ?? '') : attached);
      break;
    }
  }
  return envCommand([], optionValues);
}

/**
 * Reads a command wrapper's argv and returns the command it runs. `xargs` appends arguments
 * read from stdin, which this check cannot see, and an option a wrapper's grammar does not
 * list — `env -C`, `env -P`, an unknown flag — can change what runs or where, so both are
 * `'opaque'`. Returns `null` when the program is not a wrapper.
 */
export function unwrapCommand(
  executable: string,
  args: readonly string[],
): WrappedCommand | 'opaque' | null {
  const program = executableName(executable);
  if (program === 'env') return unwrapEnv(args);
  if (program === 'xargs') return 'opaque';
  const grammar = WRAPPERS.get(program);
  return grammar === undefined ? null : unwrapByGrammar(grammar, args);
}

import {
  INLINE_CODE_FLAGS,
  NODE_SYNTAX_CHECK_FLAGS,
  nodeParsesOnly,
} from '../interpreter-flags.js';
import { lookup, isFlag, SCRIPT_FILE } from './programs.js';

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

/** An interpreter's name without the version an install can carry (`python3.12`, `pypy3`). */
function interpreterName(program: string): string {
  return program.toLowerCase().replace(/[\d.]+$/, '');
}

type InterpreterCall =
  | { kind: 'refused'; reason: string }
  | { kind: 'module'; command: string[] }
  | { kind: 'parse-only' }
  | { kind: 'script'; file: string };

/**
 * What an interpreter command runs. A parse-only call names no check definition, including when
 * a package manager forwards it rather than naming a package script.
 */
export function interpreterCall(tokens: readonly string[]): InterpreterCall | null {
  const program = interpreterName(tokens[0] ?? '');
  const subcommands = lookup(SUBCOMMAND_INTERPRETERS, program);
  if (!SCRIPT_INTERPRETERS.has(program) && subcommands === undefined) return null;
  const codeOptions = lookup(INTERPRETER_CODE_OPTIONS, program);
  const codeFlags = codeOptions?.flags ?? INLINE_CODE_FLAGS;
  const node = program === 'node' || program === 'nodejs';
  const operandAt = tokens.findIndex((arg, index) => index > 0 && !isFlag(arg));
  const parsesOnly =
    node && nodeParsesOnly(tokens.slice(1, operandAt === -1 ? undefined : operandAt));
  let runs = false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index] ?? '';
    if (arg === '-') {
      return { kind: 'refused', reason: `reads code from standard input (${tokens[0]} -)` };
    }
    if (!isFlag(arg) || arg === '--') {
      if (codeOptions?.scriptOperand === false) continue;
      if (arg === '--') index++;
      const operand = tokens[index];
      if (operand === undefined) return null;
      if (subcommands === undefined) {
        return parsesOnly ? { kind: 'parse-only' } : { kind: 'script', file: operand };
      }
      if (!runs && subcommands.inline.includes(operand)) {
        return { kind: 'refused', reason: `runs the code-execution command ${program} ${operand}` };
      }
      if (SCRIPT_FILE.test(operand)) return { kind: 'script', file: operand };
      // `deno run x.ts` and `bun run x.ts` run the file after `run`; `bun run test` runs a script.
      if (runs || operand !== 'run') return null;
      runs = true;
      continue;
    }
    if (subcommands?.codeOptions === false) continue;
    if (parsesOnly && NODE_SYNTAX_CHECK_FLAGS.has(arg)) continue;
    if ((program === 'python' || program === 'pypy') && arg.startsWith('-m')) {
      const next = arg === '-m' ? index + 2 : index + 1;
      const module = arg === '-m' ? tokens[index + 1] : arg.slice(2);
      return {
        kind: 'module',
        command: module === undefined ? [] : [module, ...tokens.slice(next)],
      };
    }
    if (arg.startsWith('--') || codeOptions?.clustered === false) {
      const flag = arg.replace(/=.*$/s, '');
      if (codeFlags.has(flag)) {
        return {
          kind: 'refused',
          reason: `uses the code-loading option ${tokens[0]} ${flag}`,
        };
      }
      if (codeOptions?.values?.has(arg) === true) index++;
      continue;
    }
    const letters = arg.slice(1);
    for (const [offset, letter] of [...letters].entries()) {
      if (lookup(VALUE_LETTERS, program)?.includes(letter) === true) {
        if (offset === letters.length - 1) index++;
        break;
      }
      if (codeFlags.has(`-${letter}`)) {
        return {
          kind: 'refused',
          reason: `uses the code-loading option ${tokens[0]} -${letter}`,
        };
      }
    }
  }
  return null;
}

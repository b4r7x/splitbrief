import { executableName, isPosixShell } from './interpreter-command-string.js';

/**
 * What an interpreter invocation runs, read from its argv alone. `loads` holds every file or
 * module the interpreter may execute — the script and any preload — `programs` holds JavaScript
 * passed inline, and `passed` holds the arguments the interpreter reads as data or hands on to
 * the program. `readsWorkingDirectory` marks an invocation that resolves code from the working
 * directory on its own, which is the checkout or its worktree.
 */
export type InterpreterArguments = Readonly<{
  loads: readonly string[];
  programs: readonly string[];
  passed: readonly string[];
  readsWorkingDirectory: boolean;
}>;

type Reading = InterpreterArguments | 'opaque';

const NOTHING: InterpreterArguments = {
  loads: [],
  programs: [],
  passed: [],
  readsWorkingDirectory: false,
};
const READS_WORKING_DIRECTORY: InterpreterArguments = { ...NOTHING, readsWorkingDirectory: true };

const VERSION_OR_HELP = new Set(['-h', '-v', '-V', '--help', '--version']);
const PYTHON = /^(python|pypy)\d*(\.\d+)?$/;
const NODE = new Set(['node', 'nodejs']);
const SCRIPT_ONLY = new Set(['perl', 'php', 'ruby']);
const OPAQUE_SHELLS = new Set(['cmd', 'csh', 'fish', 'powershell', 'pwsh', 'tcsh']);

const NODE_PROGRAM_OPTIONS = new Set(['-e', '--eval', '-p', '--print', '-pe']);
const NODE_LOAD_OPTIONS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--env-file-if-exists',
  '--experimental-config-file',
  '--openssl-config',
  '--snapshot-blob',
]);
const NODE_PROJECT_OPTIONS = new Set(['--run', '--test', '--experimental-default-config-file']);
const NODE_VALUE_OPTIONS = new Set([
  '-C',
  '--conditions',
  '--disable-warning',
  '--input-type',
  '--title',
  '--unhandled-rejections',
  '--watch-path',
]);
const NODE_FLAGS = new Set([
  ...VERSION_OR_HELP,
  '-c',
  '-i',
  '--check',
  '--enable-source-maps',
  '--experimental-strip-types',
  '--inspect',
  '--inspect-brk',
  '--interactive',
  '--no-deprecation',
  '--no-warnings',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--trace-uncaught',
  '--trace-warnings',
  '--watch',
]);

const SHELL_OPTIONS_WITH_ARGUMENT = new Set(['-o', '+o', '-O', '+O']);
const SHELL_STARTUP_FILES = new Set(['--rcfile', '--init-file']);

/**
 * Ends a scan at `index`. When `runsScript` is set the token there is the script; every later
 * token is passed on to the program.
 */
function endAt(
  read: Pick<InterpreterArguments, 'loads' | 'programs' | 'passed'>,
  args: readonly string[],
  index: number,
  runsScript: boolean,
): InterpreterArguments {
  return {
    loads: runsScript ? [...read.loads, ...args.slice(index, index + 1)] : read.loads,
    programs: read.programs,
    passed: [...read.passed, ...args.slice(runsScript ? index + 1 : index)],
    readsWorkingDirectory: false,
  };
}

/**
 * Node options are whole tokens. An option this table does not know may take the next token as
 * its value, so that token is kept as a possible script and the scan goes on as if it were the
 * value: every token that could be the script is read as one.
 */
export function readNodeArguments(args: readonly string[]): InterpreterArguments {
  const loads: string[] = [];
  const programs: string[] = [];
  const passed: string[] = [];
  const read = { loads, programs, passed };
  let valueMayFollow = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-') return endAt(read, args, index + 1, false);
    if (arg === '--') return endAt(read, args, index + 1, true);
    if (!arg.startsWith('-')) {
      if (!valueMayFollow) return endAt(read, args, index, true);
      loads.push(arg);
      valueMayFollow = false;
      continue;
    }
    valueMayFollow = false;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (NODE_PROJECT_OPTIONS.has(name)) return READS_WORKING_DIRECTORY;
    const target = NODE_PROGRAM_OPTIONS.has(name)
      ? programs
      : NODE_LOAD_OPTIONS.has(name)
        ? loads
        : NODE_VALUE_OPTIONS.has(name)
          ? passed
          : null;
    if (target === null) {
      if (eq !== -1) passed.push(arg);
      else valueMayFollow = !NODE_FLAGS.has(name);
      continue;
    }
    const value = eq === -1 ? args[++index] : arg.slice(eq + 1);
    if (value !== undefined) target.push(value);
  }
  return endAt(read, args, args.length, false);
}

/**
 * `-c` and `-m` put the working directory first on `sys.path`, so a module there shadows the
 * system one — including a module the repository or the implementer adds after this check.
 */
function readPythonArguments(args: readonly string[]): InterpreterArguments {
  const passed: string[] = [];
  const read = { ...NOTHING, passed };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-') return endAt(read, args, index + 1, false);
    if (arg === '--') return endAt(read, args, index + 1, true);
    if (!arg.startsWith('-')) return endAt(read, args, index, true);
    if (arg === '--check-hash-based-pycs') {
      passed.push(args[++index] ?? '');
      continue;
    }
    if (arg.startsWith('--')) continue;
    for (let at = 1; at < arg.length; at += 1) {
      const letter = arg.charAt(at);
      if (letter === 'c' || letter === 'm') return READS_WORKING_DIRECTORY;
      if (letter === 'W' || letter === 'X') {
        passed.push(at === arg.length - 1 ? (args[++index] ?? '') : arg.slice(at + 1));
        break;
      }
    }
  }
  return endAt(read, args, args.length, false);
}

/** A shell outside `-c` mode runs its first operand as a script, or reads stdin under `-s`. */
function readShellArguments(args: readonly string[]): Reading {
  const loads: string[] = [];
  const passed: string[] = [];
  const read = { ...NOTHING, loads, passed };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-') return endAt(read, args, index + 1, false);
    if (arg === '--') return endAt(read, args, index + 1, true);
    if (!arg.startsWith('-') && !arg.startsWith('+')) return endAt(read, args, index, true);
    const eq = arg.indexOf('=');
    if (SHELL_STARTUP_FILES.has(eq === -1 ? arg : arg.slice(0, eq))) {
      loads.push(eq === -1 ? (args[++index] ?? '') : arg.slice(eq + 1));
    } else if (SHELL_OPTIONS_WITH_ARGUMENT.has(arg)) {
      passed.push(args[++index] ?? '');
    } else if (!arg.startsWith('--')) {
      if (/[oO]/.test(arg)) return 'opaque';
      if (arg.includes('s')) return endAt(read, args, index + 1, false);
    }
  }
  return endAt(read, args, args.length, false);
}

function readScriptArguments(args: readonly string[]): Reading {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('-')) return endAt(NOTHING, args, index, true);
    if (!VERSION_OR_HELP.has(arg)) return 'opaque';
  }
  return NOTHING;
}

export function isInterpreter(executable: string): boolean {
  const program = executableName(executable);
  return (
    isPosixShell(program) ||
    OPAQUE_SHELLS.has(program) ||
    NODE.has(program) ||
    PYTHON.test(program) ||
    SCRIPT_ONLY.has(program)
  );
}

/**
 * Reads the argv of a shell outside `-c` mode, or of a language interpreter. Returns `null` for
 * any other program and `'opaque'` for a form the grammar does not model. fish, csh and
 * PowerShell are not modelled, so any argument is repo-local for them. Bun, Deno, npx, tsx and
 * ts-node read configuration or packages from the working directory, so they are classified with
 * the task runners (`runsProjectDefinedCode`), not here.
 */
export function readInterpreterArguments(
  executable: string,
  args: readonly string[],
): Reading | null {
  const program = executableName(executable);
  if (isPosixShell(program)) return readShellArguments(args);
  if (NODE.has(program)) return readNodeArguments(args);
  if (PYTHON.test(program)) return readPythonArguments(args);
  if (SCRIPT_ONLY.has(program)) return readScriptArguments(args);
  if (OPAQUE_SHELLS.has(program)) return args.length === 0 ? NOTHING : 'opaque';
  return null;
}

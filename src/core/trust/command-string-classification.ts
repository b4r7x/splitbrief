import { unwrapCommand } from './command-wrappers.js';
import {
  type InterpreterArguments,
  isInterpreter,
  readInterpreterArguments,
  readNodeArguments,
} from './interpreter-arguments.js';
import { runsPosixShellCommandString } from './interpreter-command-string.js';
import {
  existsInProject,
  isBareCommandResolvedInsideProject,
  isInsideProject,
  isPackageManagerScriptInvocation,
  isPathLike,
  isProjectDrivenProgram,
  runsProjectDefinedCode,
} from './path-classification.js';

type ShellWord = Readonly<{ value: string; redirect: boolean }>;

type ShellScript = Readonly<{ commands: readonly (readonly ShellWord[])[]; pipes: boolean }>;

const SHELL_OPTIONS_WITH_ARGUMENT = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const UNQUOTED_EXPANSIONS = new Set(['$', '`', '\\', '*', '?', '[', ']', '{', '}', '~', '#']);
const COMMAND_SEPARATORS = new Set([';', '&', '(', ')', '\n']);
const REDIRECT_OPERATOR = /&>>|&>|>>|>&|>\||<>|<&|<|>/y;
const INDIRECTIONS = new Set(['eval', 'source', '.', 'cd', 'pushd', 'popd']);
const SHELL_SIGNIFICANT = /[\s;&|<>()$`\\*?[~'"]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const STREAM_TARGET = /^(\d+|-|\/dev\/(null|stdout|stderr))$/;
const JS_DYNAMIC_ACCESS = /[^\t\n\x20-\x7e]|[[\\`]/;
const JS_LOADERS =
  /\b(?:eval|Function|constructor|prototype|__proto__|module|exports|global|globalThis|Reflect|Proxy|Object|getBuiltinModule|binding|_linkedBinding|dlopen|mainModule|execve|WebAssembly|Worker|Bun|Deno|child_process|cluster|createRequire|inspector|loadExtension|repl|sqlite|v8|vm|wasi|worker_threads)\b/;
const JS_BUILTIN_LOAD = /\b(?:require|import)\(\s*(['"])node:[\w/]+\1\s*\)/g;
const JS_MODULE_LOAD = /\b(?:require|import)\b/;
const CODE_LOADING_ENVIRONMENT =
  /^(?:PATH|HOME|ENV|ZDOTDIR|CDPATH|BASH_ENV|NODE_PATH|PERL\w*|PYTHON\w+|RUBY\w+|LD_\w+|DYLD_\w+|GIT_\w+|NPM_CONFIG_\w+|npm_config_\w+)$/;

function commandStringIndex(argv: readonly string[]): number | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--' || argument === '-') return index + 1 < argv.length ? index + 1 : null;
    if (!argument.startsWith('-') && !argument.startsWith('+')) return index;
    if (argument.startsWith('--command')) return null;
    if (SHELL_OPTIONS_WITH_ARGUMENT.has(argument)) index += 1;
    else if (!argument.startsWith('--') && /[oO]/.test(argument)) return null;
  }
  return null;
}

function redirectOperatorLength(script: string, index: number): number {
  REDIRECT_OPERATOR.lastIndex = index;
  return REDIRECT_OPERATOR.exec(script)?.[0].length ?? 1;
}

function lexScript(script: string): ShellScript | null {
  const commands: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let value = '';
  let started = false;
  let quoted = false;
  let redirect = false;
  let pipes = false;

  const endWord = (): void => {
    if (!started) return;
    words.push({ value, redirect });
    value = '';
    started = false;
    quoted = false;
    redirect = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
    redirect = false;
  };

  for (let index = 0; index < script.length; index += 1) {
    const char = script.charAt(index);
    const next = script.charAt(index + 1);
    if (char === "'" || char === '"') {
      const close = script.indexOf(char, index + 1);
      if (close === -1) return null;
      const text = script.slice(index + 1, close);
      if (char === '"' && /[$`\\]/.test(text)) return null;
      value += text;
      started = true;
      quoted = true;
      index = close;
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      if (char === '<' && next === '<') return null;
      const length = redirectOperatorLength(script, index);
      if (script.charAt(index + length) === '(') return null;
      if (char !== '&' && started && !quoted && /^\d+$/.test(value)) {
        value = '';
        started = false;
      } else {
        endWord();
      }
      redirect = true;
      index += length - 1;
    } else if (char === '|') {
      if (next === '|') index += 1;
      else pipes = true;
      endCommand();
    } else if (COMMAND_SEPARATORS.has(char)) {
      endCommand();
    } else if (UNQUOTED_EXPANSIONS.has(char)) {
      return null;
    } else {
      value += char;
      started = true;
    }
  }
  endCommand();
  return { commands, pipes };
}

function referencesProject(value: string, projectDir: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/')) {
    return value === '/proc' || value.startsWith('/proc/') || isInsideProject(projectDir, value);
  }
  if (isPathLike(value)) return true;
  return (
    existsInProject(value, projectDir) || isBareCommandResolvedInsideProject(value, projectDir)
  );
}

function commandNameIsRepoLocal(value: string, projectDir: string): boolean {
  if (isPathLike(value)) return referencesProject(value, projectDir);
  return isBareCommandResolvedInsideProject(value, projectDir);
}

function argumentIsRepoLocal(value: string, projectDir: string): boolean {
  if (!value.startsWith('-')) return referencesProject(value, projectDir);
  const eq = value.indexOf('=');
  return eq === -1 ? isPathLike(value) : referencesProject(value.slice(eq + 1), projectDir);
}

function isUnclassifiable(value: string): boolean {
  return (
    INDIRECTIONS.has(value) ||
    value === '-C' ||
    value.startsWith('--chdir') ||
    value.startsWith('=') ||
    ASSIGNMENT.test(value) ||
    SHELL_SIGNIFICANT.test(value)
  );
}

function printsText(argv: readonly string[]): boolean {
  const [name, ...args] = argv;
  if (name === 'echo') return true;
  return name === 'printf' && !args.some((arg) => arg.startsWith('-v'));
}

function commandIsRepoLocal(
  words: readonly ShellWord[],
  outputStaysOnStreams: boolean,
  projectDir: string,
): boolean {
  if (words.some((word) => word.redirect && referencesProject(word.value, projectDir))) return true;
  const argv = words.filter((word) => !word.redirect).map((word) => word.value);
  if (argv.some((_, index) => isPackageManagerScriptInvocation(argv.slice(index)))) return true;
  const [name, ...args] = argv;
  if (name === undefined) return false;
  if (isUnclassifiable(name) || commandNameIsRepoLocal(name, projectDir)) return true;
  if (outputStaysOnStreams && printsText(argv)) return false;
  return (
    args.some((arg) => isUnclassifiable(arg) || argumentIsRepoLocal(arg, projectDir)) ||
    argvIsRepoLocal(argv, projectDir)
  );
}

function scriptIsRepoLocal(script: string, projectDir: string): boolean {
  const lexed = lexScript(script);
  if (lexed === null) return true;
  const outputStaysOnStreams =
    !lexed.pipes &&
    lexed.commands.every((words) =>
      words.every((word) => !word.redirect || STREAM_TARGET.test(word.value)),
    );
  return lexed.commands.some((words) =>
    commandIsRepoLocal(words, outputStaysOnStreams, projectDir),
  );
}

function namesProgram(value: string): boolean {
  if (value.startsWith('-') || /\s/.test(value)) return false;
  return isInterpreter(value) || isProjectDrivenProgram(value);
}

function passedArgumentIsRepoLocal(value: string, projectDir: string): boolean {
  return argumentIsRepoLocal(value, projectDir) || namesProgram(value);
}

function loadIsRepoLocal(value: string, projectDir: string): boolean {
  if (value.startsWith('node:')) return false;
  return !value.startsWith('/') || referencesProject(value, projectDir);
}

/**
 * Inline JavaScript can reach project code only through a loader it names — a module load,
 * `eval`, a spawning or evaluating builtin — or through a name built from data: computed
 * member access, escapes, template literals, non-ASCII look-alikes. A `require` of a `node:`
 * builtin outside that list loads nothing from the project.
 */
function programLoadsCode(program: string): boolean {
  if (JS_DYNAMIC_ACCESS.test(program) || JS_LOADERS.test(program)) return true;
  return JS_MODULE_LOAD.test(program.replace(JS_BUILTIN_LOAD, ''));
}

function interpreterIsRepoLocal(
  invocation: InterpreterArguments | 'opaque',
  projectDir: string,
): boolean {
  if (invocation === 'opaque' || invocation.readsWorkingDirectory) return true;
  return (
    invocation.loads.some((value) => loadIsRepoLocal(value, projectDir)) ||
    invocation.programs.some(programLoadsCode) ||
    invocation.passed.some((value) => passedArgumentIsRepoLocal(value, projectDir))
  );
}

function assignmentIsRepoLocal(assignment: string, projectDir: string): boolean {
  const eq = assignment.indexOf('=');
  const name = assignment.slice(0, eq);
  const value = assignment.slice(eq + 1);
  if (name === 'NODE_OPTIONS') {
    const options = value.split(/\s+/).filter((option) => option.length > 0);
    return /["'\\]/.test(value) || interpreterIsRepoLocal(readNodeArguments(options), projectDir);
  }
  return CODE_LOADING_ENVIRONMENT.test(name) || referencesProject(value, projectDir);
}

/**
 * Classifies one argv — a runner's command or one command of a shell script — by what the
 * program does with each argument. A command wrapper is classified by the command it runs and
 * the environment it sets; an interpreter by the script, modules and inline program it loads;
 * a shell by its `-c` script or its script file; a task runner, build tool, test runner or
 * package manager by whether its argv is one of the safe forms pinned for it and whether a project
 * file selects its binary. Any other program is repo-local when an argument is a path into the
 * project or names a program it could run.
 */
export function argvIsRepoLocal(argv: readonly string[], projectDir: string): boolean {
  const [name, ...args] = argv;
  if (name === undefined) return false;
  if (commandNameIsRepoLocal(name, projectDir) || runsProjectDefinedCode(argv, projectDir)) {
    return true;
  }
  if (runsShellCommandString(argv)) return shellCommandStringIsRepoLocal(argv, projectDir);
  const wrapped = unwrapCommand(name, args);
  if (wrapped === 'opaque') return true;
  if (wrapped !== null) {
    return (
      wrapped.assignments.some((assignment) => assignmentIsRepoLocal(assignment, projectDir)) ||
      wrapped.optionValues.some((value) => argumentIsRepoLocal(value, projectDir)) ||
      argvIsRepoLocal(wrapped.argv, projectDir)
    );
  }
  const invocation = readInterpreterArguments(name, args);
  if (invocation !== null) return interpreterIsRepoLocal(invocation, projectDir);
  return args.some((arg) => passedArgumentIsRepoLocal(arg, projectDir));
}

export function runsShellCommandString(tokens: readonly string[]): boolean {
  const [executable, ...argv] = tokens;
  return executable !== undefined && runsPosixShellCommandString(executable, argv);
}

/**
 * Classifies a POSIX shell `-c` invocation word by word instead of as one opaque token.
 * An absolute path outside the project is not repo-local; a relative path, an absolute path
 * inside the project (lexically or through symlinks), a bare argument that names an entry of the
 * project, or a command that PATH resolves into the project is. Anything the lexer cannot settle
 * without running the shell — expansions, substitutions, globs, heredocs, escapes, `cd`, `eval`,
 * `source`, assignments, nested command strings — counts as repo-local, so the check fails closed.
 * The arguments of `echo`/`printf` are skipped only in a script without pipes or file redirects,
 * where the printed text cannot reach another interpreter.
 */
export function shellCommandStringIsRepoLocal(
  tokens: readonly string[],
  projectDir: string,
): boolean {
  const [executable = '', ...argv] = tokens;
  const scriptIndex = commandStringIndex(argv);
  if (scriptIndex === null) return true;
  if (commandNameIsRepoLocal(executable, projectDir)) return true;
  return argv.some((token, index) =>
    index === scriptIndex
      ? scriptIsRepoLocal(token, projectDir)
      : argumentIsRepoLocal(token, projectDir),
  );
}

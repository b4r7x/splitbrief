import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, extname, resolve } from 'node:path';
import { isInsideRoot } from '../../lib/path-confinement.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';

const CODE_LOADING_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'npx',
  'tsx',
  'ts-node',
  'bun',
  'deno',
]);

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_SCRIPT_ALIASES = new Set(['start', 'stop', 'restart', 'test']);
const PROMPT_PLACEHOLDER = '{prompt}';
const SHELL_EVALUATORS = new Set(['sh', 'bash']);
const INLINE_PROGRAM_FLAGS = new Map<string, ReadonlySet<string>>([
  ['node', new Set(['-e', '--eval', '-p', '--print'])],
  ['nodejs', new Set(['-e', '--eval', '-p', '--print'])],
  ['python', new Set(['-c'])],
  ['python3', new Set(['-c'])],
  ['ruby', new Set(['-e'])],
  ['perl', new Set(['-e', '-E'])],
  ['php', new Set(['-r'])],
  ['tsx', new Set(['-e', '--eval'])],
  ['ts-node', new Set(['-e', '--eval'])],
  ['bun', new Set(['-e', '--eval'])],
]);

export function isPathLike(token: string): boolean {
  if (token.includes('/') || token.includes('\\')) return true;
  return /^[a-zA-Z0-9_.-]+[\\/][a-zA-Z0-9_.\\/-]+$/.test(token);
}

export function isRepoLocal(token: string, projectDir: string): boolean {
  if (token.startsWith('./') || token.startsWith('../')) return true;
  if (token.startsWith('/')) {
    return isInsideRoot(resolve(projectDir), resolve(token));
  }
  if (isPathLike(token)) return true;
  return false;
}

export function commandTokensAfterInterpreter(tokens: readonly string[]): readonly string[] {
  const interpreter = tokens[0] ?? '';
  const name = commandName(interpreter);
  if (!CODE_LOADING_INTERPRETERS.has(name) || tokens.length <= 1) return tokens;
  return interpreterPathTokens(name, tokens.slice(1));
}

export function commandName(command: string): string {
  const executable = parseShellCommand(command)[0] ?? command;
  const name = executable.split(/[\\/]/).pop() ?? executable;
  return name.replace(/\.(cmd|exe|bat|ps1)$/i, '');
}

function interpreterPathTokens(interpreter: string, tokens: readonly string[]): string[] {
  const pathTokens: string[] = [];
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (isInlineProgramFlag(interpreter, token)) {
      skipNext = !token.includes('=');
      continue;
    }
    pathTokens.push(token);
  }

  return pathTokens;
}

function isInlineProgramFlag(interpreter: string, token: string): boolean {
  const flags = INLINE_PROGRAM_FLAGS.get(interpreter);
  if (flags === undefined) return false;
  return flags.has(flagName(token));
}

function flagName(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

function firstNonOptionIndex(tokens: readonly string[], start: number): number | null {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === '--') return null;
    if (token.startsWith('-') && token !== '-') continue;
    return i;
  }
  return null;
}

function hasScriptNameAfterRun(tokens: readonly string[], runIndex: number): boolean {
  return firstNonOptionIndex(tokens, runIndex + 1) !== null;
}

export function isPackageManagerScriptInvocation(tokens: readonly string[]): boolean {
  if (tokens.length < 2) return false;
  const manager = commandName(tokens[0] ?? '');
  if (!PACKAGE_MANAGERS.has(manager)) return false;

  const subcommandIndex = firstNonOptionIndex(tokens, 1);
  if (subcommandIndex === null) return false;

  const subcommand = tokens[subcommandIndex] ?? '';
  if (subcommand === 'run' || subcommand === 'run-script') {
    return hasScriptNameAfterRun(tokens, subcommandIndex);
  }

  return PACKAGE_SCRIPT_ALIASES.has(subcommand);
}

function executableExtensions(command: string): string[] {
  if (process.platform !== 'win32' || extname(command) !== '') return [''];
  const pathext = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return pathext
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBareCommandOnPath(
  command: string,
  cwd: string,
  pathEnv = process.env['PATH'] ?? '',
): string | null {
  if (command.length === 0 || isPathLike(command)) return null;

  for (const entry of pathEnv.split(delimiter)) {
    const dir = entry.length > 0 ? entry : cwd;
    for (const ext of executableExtensions(command)) {
      const candidate = resolve(dir, `${command}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return null;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isBareCommandResolvedInsideProject(
  command: string,
  projectDir: string,
  pathEnv = process.env['PATH'] ?? '',
): boolean {
  const resolved = resolveBareCommandOnPath(command, projectDir, pathEnv);
  if (resolved === null) return false;

  const root = resolve(projectDir);
  const target = resolve(resolved);
  if (isInsideRoot(root, target)) return true;

  return isInsideRoot(realpathOrResolve(projectDir), realpathOrResolve(resolved));
}

export function isShellEvaluatedPromptArg(
  command: string,
  args: readonly string[],
  placeholder = PROMPT_PLACEHOLDER,
): boolean {
  const name = commandName(command);
  if (!SHELL_EVALUATORS.has(name)) return false;
  return shellArgsEvaluateCommandString(args) && args.some((arg) => arg.includes(placeholder));
}

export function shellArgsEvaluateCommandString(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '-c') return true;
    if (isCombinedShellCommandFlag(arg)) return true;
    if (!arg.startsWith('-') || arg === '-') return false;
  }
  return false;
}

function isCombinedShellCommandFlag(arg: string): boolean {
  return (
    arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2 && arg.slice(1).includes('c')
  );
}

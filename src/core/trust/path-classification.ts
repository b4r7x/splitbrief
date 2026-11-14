import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isInsideRoot } from '../../lib/fs/confinement.js';
import { resolveBareCommandOnPath } from '../../lib/process/command-path.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { executableName } from './interpreter-command-string.js';

const CODE_LOADING_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'ruby',
  'perl',
  'php',
  'npx',
  'tsx',
  'ts-node',
  'nodemon',
  'bun',
  'deno',
]);

const NODE_INTERPRETERS = new Set(['node', 'nodejs']);

const INLINE_PROGRAM_FLAGS = new Map<string, ReadonlySet<string>>([
  ['node', new Set(['-e', '--eval', '-p', '--print'])],
  ['nodejs', new Set(['-e', '--eval', '-p', '--print'])],
  ['python', new Set(['-c'])],
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
  const name = interpreterName(interpreter);
  if (!CODE_LOADING_INTERPRETERS.has(name) || tokens.length <= 1) return tokens;
  return interpreterPathTokens(name, tokens.slice(1));
}

// The operands of the first interpreter anywhere in the argv: `yarn tsx check.ts` and
// `timeout 5 node check.mjs` run their file as `node check.mjs` does.
export function interpreterOperands(tokens: readonly string[]): readonly string[] {
  const at = tokens.findIndex((token) => CODE_LOADING_INTERPRETERS.has(interpreterName(token)));
  if (at === -1) return [];
  return interpreterPathTokens(interpreterName(tokens[at] ?? ''), tokens.slice(at + 1));
}

// The operands of the first node interpreter anywhere in the argv. Node resolves its entry point
// the way require() does; the other code-loading interpreters name their file exactly, so only
// node/nodejs run a file the operand does not spell literally.
export function nodeEntryPointOperands(tokens: readonly string[]): readonly string[] {
  const at = tokens.findIndex((token) => NODE_INTERPRETERS.has(interpreterName(token)));
  if (at === -1) return [];
  return interpreterPathTokens(interpreterName(tokens[at] ?? ''), tokens.slice(at + 1));
}

export function commandName(command: string): string {
  const executable = parseShellCommand(command)[0] ?? command;
  return executableName(executable);
}

// `npm@10` and `tsx@4` name the registry packages whose binaries are `npm` and `tsx`.
export function withoutPackageSpec(command: string): string {
  const name = commandName(command);
  return name.startsWith('@') ? name : name.replace(/@[^@]*$/, '');
}

// The free-threaded `python3.13t`, the windowed `pythonw` and `pypy3` all run the Python
// interpreter.
const PYTHON_NAME = /^(?:pythonw?|pypy)\d*(?:\.\d+)*t?$/;

// A versioned binary such as `python3.13` or `perl5.34` runs the interpreter it names.
function interpreterName(command: string): string {
  const name = withoutPackageSpec(command);
  if (PYTHON_NAME.test(name)) return 'python';
  return name.replace(/\d+(\.\d+)*$/, '');
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

export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function existsInProject(name: string, projectDir: string): boolean {
  return entryExists(resolve(projectDir, name));
}

export function isProjectFile(input: { name: string; projectDir: string }): boolean {
  const { name, projectDir } = input;
  try {
    return lstatSync(resolve(projectDir, name)).isFile();
  } catch {
    return false;
  }
}

export function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isInsideProject(projectDir: string, target: string): boolean {
  if (isInsideRoot(resolve(projectDir), resolve(target))) return true;
  return isInsideRoot(realpathOrResolve(projectDir), realpathOrResolve(target));
}

export function isBareCommandResolvedInsideProject(
  command: string,
  projectDir: string,
  pathEnv = process.env['PATH'] ?? '',
): boolean {
  const resolved = resolveBareCommandOnPath(command, projectDir, pathEnv);
  return resolved !== null && isInsideProject(projectDir, resolved);
}

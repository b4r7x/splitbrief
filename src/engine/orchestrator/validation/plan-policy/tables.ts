import { isAbsolute } from 'node:path';
import { VALIDATION_STAGES } from '../../../../core/schemas/enums.js';
import { pythonStack } from '../../../../core/validation/stacks/python.js';
import { STACKS } from '../../../../core/validation/stacks/registry.js';

const PACKAGE_MANAGERS = ['npm', 'npx', 'node', 'pnpm', 'yarn', 'bun', 'make', 'just'];

export const ALLOWED_COMMANDS = new Set([
  ...PACKAGE_MANAGERS,
  ...STACKS.flatMap((stack) => stack.allowedCommands),
]);

export const SHELL_OPERATORS = /[|&;`$(){}]/;

export const INTERPRETERS = new Set(['node', 'python', 'python3']);

export const NPX_CODE_LOAD_PACKAGES = new Set(['tsx', 'ts-node', 'ts-node/esm', 'node']);

export const NPM_SCRIPT_SUBCOMMANDS = new Set(['run', 'exec', 'exec-env', 'explore']);

export const PNPM_SCRIPT_SUBCOMMANDS = new Set(['run', 'exec', 'dlx']);

export const YARN_SCRIPT_SUBCOMMANDS = new Set(['run', 'dlx']);

export const RUN_TEST_ALIASES = new Set(['npm', 'pnpm', 'yarn']);

export const TASK_RUNNERS = new Set(['make', 'just']);

export const STAGE_TARGETS = new Set<string>(VALIDATION_STAGES);

export const RUN_FRONT_ENDS = new Set(['uv', 'poetry']);

export const PYTHON_TOOLS = new Set(pythonStack.allowedCommands);

export const NPX_STACK_TOOLS = new Set(
  STACKS.flatMap((stack) => stack.allowedCommands).filter(
    (tool) =>
      !PACKAGE_MANAGERS.includes(tool) &&
      !INTERPRETERS.has(tool) &&
      !NPX_CODE_LOAD_PACKAGES.has(tool) &&
      !RUN_FRONT_ENDS.has(tool),
  ),
);

export const TEST_CONFIG_FLAGS = new Set(['--config', '-c']);

export function commandFamily(token: string): string {
  // npx accepts a version, tag, or empty suffix after an unscoped package name.
  const name = token.toLowerCase();
  return name.startsWith('@') || name.includes('/') || name.includes('\\')
    ? name
    : name.replace(/@[^@]*$/, '');
}

export function isPathLikeScriptArg(arg: string): boolean {
  if (arg.includes('/') || arg.includes('\\')) return true;
  if (arg.startsWith('.')) return true;
  if (arg === 'scripts' || arg.startsWith('scripts')) return true;
  return /\.(?:[cm]?[jt]sx?|py)$/.test(arg);
}

export function executedProgramPositions(tokens: string[]): number[] {
  const positions: number[] = [];
  let start = 0;
  while (start < tokens.length) {
    positions.push(start);
    const program = commandFamily(tokens[start] ?? '');
    if (program === 'npx') {
      start = tokens.findIndex((token, index) => index > start && !token.startsWith('-'));
      if (start === -1) break;
    } else if (RUN_FRONT_ENDS.has(program) && tokens[start + 1] === 'run') {
      start += 2;
    } else {
      break;
    }
  }
  return positions;
}

export const NODE_TEST_STACKS = STACKS.filter((stack) => stack.allowedCommands.includes('node'));

export function isWorkspacePath(arg: string): boolean {
  return !isAbsolute(arg) && !arg.split(/[\\/]/).includes('..');
}

export function isWorkspaceFile(arg: string): boolean {
  return isWorkspacePath(arg) && !/[*?[\]]/.test(arg) && !arg.endsWith('/');
}

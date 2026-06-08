import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { isTestPatternSafe } from '../../../core/validation/test-discovery.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { warnStderr } from '../../../lib/warn.js';

const ALLOWED_COMMANDS = new Set([
  'npm',
  'npx',
  'node',
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  'biome',
  'cargo',
  'go',
  'golangci-lint',
  'pytest',
  'mypy',
  'ruff',
  'pnpm',
  'yarn',
  'bun',
]);

const SHELL_OPERATORS = /[|&;`$(){}]/;

const NODE_CODE_LOAD_FLAGS = new Set([
  '-e',
  '--eval',
  '-r',
  '--require',
  '--import',
  '-i',
  '--input-type',
]);

const NPX_CODE_LOAD_PACKAGES = new Set(['tsx', 'ts-node', 'ts-node/esm', 'node']);

const NPM_SCRIPT_SUBCOMMANDS = new Set(['run', 'exec', 'exec-env', 'explore']);

const PNPM_SCRIPT_SUBCOMMANDS = new Set(['run', 'exec', 'dlx']);

const YARN_SCRIPT_SUBCOMMANDS = new Set(['run', 'dlx']);

const TEST_CONFIG_FLAGS = new Set(['--config', '-c']);

function isPathLikeScriptArg(arg: string): boolean {
  if (arg.includes('/') || arg.includes('\\')) return true;
  if (arg.startsWith('.')) return true;
  if (arg === 'scripts' || arg.startsWith('scripts')) return true;
  return false;
}

function loadsNodeScript(tokens: string[]): boolean {
  if (tokens[0] !== 'node') return false;
  let afterSeparator = false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg) continue;
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && arg.startsWith('-')) {
      if (NODE_CODE_LOAD_FLAGS.has(arg)) return true;
      continue;
    }
    if (isPathLikeScriptArg(arg)) return true;
  }
  return false;
}

function loadsNpxScript(tokens: string[]): boolean {
  if (tokens[0] !== 'npx') return false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg || arg.startsWith('-')) {
      if (arg === '--package' || arg === '-p' || arg === '--call' || arg === '-c') return true;
      continue;
    }
    if (isPathLikeScriptArg(arg)) return true;
    if (NPX_CODE_LOAD_PACKAGES.has(arg)) return true;
  }
  return false;
}

function loadsPackageScript(tokens: string[]): boolean {
  const cmd = tokens[0];
  if (!cmd) return false;
  const subcommands =
    cmd === 'npm'
      ? NPM_SCRIPT_SUBCOMMANDS
      : cmd === 'pnpm'
        ? PNPM_SCRIPT_SUBCOMMANDS
        : cmd === 'yarn'
          ? YARN_SCRIPT_SUBCOMMANDS
          : null;
  if (!subcommands) return false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg || arg.startsWith('-')) continue;
    if (subcommands.has(arg)) return true;
  }
  return false;
}

function loadsTestRunnerConfig(tokens: string[]): boolean {
  const cmd = tokens[0];
  if (cmd !== 'vitest' && cmd !== 'jest') return false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg) continue;
    if (TEST_CONFIG_FLAGS.has(arg)) {
      const value = tokens[index + 1];
      if (value && !value.startsWith('-') && isPathLikeScriptArg(value)) return true;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (isPathLikeScriptArg(value)) return true;
    }
  }
  return false;
}

function isCommandSafe(raw: string): boolean {
  const tokens = parseShellCommand(raw);
  const cmd = tokens[0];
  if (!cmd) return false;
  if (cmd.includes('/') || cmd.includes('\\')) return false;
  if (!ALLOWED_COMMANDS.has(cmd)) return false;
  if (loadsNodeScript(tokens)) return false;
  if (loadsNpxScript(tokens)) return false;
  if (loadsPackageScript(tokens)) return false;
  if (loadsTestRunnerConfig(tokens)) return false;
  for (const token of tokens) {
    if (SHELL_OPERATORS.test(token)) return false;
  }
  return true;
}

type CommandField = 'typecheckCommand' | 'lintCommand' | 'testCommand';
const COMMAND_FIELDS: CommandField[] = ['typecheckCommand', 'lintCommand', 'testCommand'];

export function sanitizeDiscoveredValidation(
  discovered: DiscoveredValidation | null | undefined,
): DiscoveredValidation | undefined {
  if (!discovered) return undefined;

  const sanitized: DiscoveredValidation = {};

  if (discovered.language) sanitized.language = discovered.language;
  if (discovered.testPattern) {
    if (isTestPatternSafe(discovered.testPattern)) {
      sanitized.testPattern = discovered.testPattern;
    } else {
      warnStderr(
        `sanitize-discovered: planner-suggested testPattern '${discovered.testPattern}' was ignored (unsafe path)`,
      );
    }
  }

  for (const field of COMMAND_FIELDS) {
    const value = discovered[field];
    if (!value) continue;
    if (isCommandSafe(value)) {
      sanitized[field] = value;
    } else {
      warnStderr(
        `sanitize-discovered: planner-suggested ${field} '${value}' was ignored (not in allowlist)`,
      );
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

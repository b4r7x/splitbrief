import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { warnStderr } from '../../../lib/warn.js';

const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'node', 'tsc',
  'vitest', 'jest', 'eslint', 'prettier', 'biome',
  'cargo', 'go', 'golangci-lint',
  'pytest', 'mypy', 'ruff',
  'pnpm', 'yarn', 'bun',
]);

const SHELL_OPERATORS = /[|&;`$(){}]/;

function isCommandSafe(raw: string): boolean {
  const tokens = parseShellCommand(raw);
  const cmd = tokens[0];
  if (!cmd) return false;
  if (cmd.includes('/') || cmd.includes('\\')) return false;
  if (!ALLOWED_COMMANDS.has(cmd)) return false;
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
  if (discovered.testPattern) sanitized.testPattern = discovered.testPattern;

  for (const field of COMMAND_FIELDS) {
    const value = discovered[field];
    if (!value) continue;
    if (isCommandSafe(value)) {
      sanitized[field] = value;
    } else {
      warnStderr(`sanitize-discovered: planner-suggested ${field} '${value}' was ignored (not in allowlist)`);
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

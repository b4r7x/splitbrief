import { resolve } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import { error } from '../../utils/error.js';

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

function isPathLike(token: string): boolean {
  if (token.includes('/') || token.includes('\\')) return true;
  // Bare repo-relative executables: scripts/runner, bin/tool (no leading ./)
  return /^[a-zA-Z0-9_.-]+[\\/][a-zA-Z0-9_.\\/-]+$/.test(token);
}

function isRepoLocal(token: string, projectDir: string): boolean {
  if (token.startsWith('./') || token.startsWith('../')) return true;
  if (token.startsWith('/')) {
    return resolve(token).startsWith(resolve(projectDir));
  }
  // Relative paths without ./ resolve against project cwd during execution.
  if (isPathLike(token)) return true;
  return false;
}

function tokenIsRepoLocalExecutable(token: string, projectDir: string): boolean {
  if (!isPathLike(token) || !isRepoLocal(token, projectDir)) return false;
  return true;
}

function commandHasRepoLocalPaths(
  command: string,
  args: readonly string[],
  projectDir: string,
): boolean {
  const tokens = [...command.split(/\s+/).filter((t) => t.length > 0), ...args];
  const interpreter = tokens[0] ?? '';
  const checkTokens =
    CODE_LOADING_INTERPRETERS.has(interpreter) && tokens.length > 1 ? tokens.slice(1) : tokens;
  for (const token of checkTokens) {
    if (token.startsWith('-')) continue;
    if (tokenIsRepoLocalExecutable(token, projectDir)) return true;
  }
  return false;
}

export interface RunnerTrustResult {
  untrustedCommands: string[];
}

export function checkRunnerTrust(config: Config, projectDir: string): RunnerTrustResult {
  const untrusted: string[] = [];

  for (const role of ['planner', 'implementer'] as const) {
    const runner = config[role];
    if (runner.kind !== 'shell' && runner.kind !== 'agent') continue;
    const command = runner.command;
    const args = runner.args ?? [];
    if (commandHasRepoLocalPaths(command, args, projectDir)) {
      untrusted.push([command, ...args].join(' '));
    }
  }

  return { untrustedCommands: untrusted };
}

export function rejectUntrustedRunners(
  config: Config,
  projectDir: string,
  allowHooks: boolean,
): void {
  const { untrustedCommands } = checkRunnerTrust(config, projectDir);
  if (untrustedCommands.length === 0) return;

  if (allowHooks) return;

  const cmds = untrustedCommands.map((c) => `  ${c}`).join('\n');
  throw error(
    'runner-not-trusted',
    `Refusing to execute repo-local runner commands from project config:\n${cmds}\n` +
      `These commands point to executables inside the repository and could be malicious. ` +
      `Re-run with --allow-hooks to trust them, or use system-installed commands instead.`,
    { commands: untrustedCommands },
  );
}

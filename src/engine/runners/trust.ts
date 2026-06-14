import type { Config } from '../../core/schemas/config.js';
import {
  commandTokensAfterInterpreter,
  isPathLike,
  isRepoLocal,
} from '../../core/trust/path-classification.js';
import { error } from '../../utils/error.js';

function tokenIsRepoLocalExecutable(token: string, projectDir: string): boolean {
  if (!isPathLike(token) || !isRepoLocal(token, projectDir)) return false;
  return true;
}

function flagValue(token: string): string | null {
  const eq = token.indexOf('=');
  if (eq === -1) return null;
  const value = token.slice(eq + 1);
  return value.length > 0 ? value : null;
}

function commandHasRepoLocalPaths(
  command: string,
  args: readonly string[],
  projectDir: string,
): boolean {
  const tokens = [...command.split(/\s+/).filter((t) => t.length > 0), ...args];
  const checkTokens = commandTokensAfterInterpreter(tokens);
  for (const token of checkTokens) {
    const candidate = token.startsWith('-') ? flagValue(token) : token;
    if (candidate === null) continue;
    if (tokenIsRepoLocalExecutable(candidate, projectDir)) return true;
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

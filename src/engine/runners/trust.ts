import { resolve } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import { error } from '../../utils/error.js';

const TRUSTED_SYSTEM_COMMANDS = new Set([
  'claude', 'claude-code', 'codex', 'opencode', 'aider', 'copilot', 'kilo-code',
  'node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno',
  'python', 'python3', 'pip', 'pipx',
  'cargo', 'go', 'rustc',
]);

function isRepoLocal(command: string, projectDir: string): boolean {
  if (command.startsWith('./') || command.startsWith('../')) return true;
  if (command.startsWith('/')) {
    return resolve(command).startsWith(resolve(projectDir));
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
    const baseCommand = command.split(/\s+/)[0] ?? command;
    if (TRUSTED_SYSTEM_COMMANDS.has(baseCommand)) continue;
    if (isRepoLocal(baseCommand, projectDir)) {
      untrusted.push(command);
    }
  }

  return { untrustedCommands: untrusted };
}

export function rejectUntrustedRunners(config: Config, projectDir: string, allowHooks: boolean): void {
  const { untrustedCommands } = checkRunnerTrust(config, projectDir);
  if (untrustedCommands.length === 0) return;

  if (allowHooks) return;

  const cmds = untrustedCommands.map(c => `  ${c}`).join('\n');
  throw error(
    'runner-not-trusted',
    `Refusing to execute repo-local runner commands from project config:\n${cmds}\n` +
    `These commands point to executables inside the repository and could be malicious. ` +
    `Re-run with --allow-hooks to trust them, or use system-installed commands instead.`,
    { commands: untrustedCommands },
  );
}

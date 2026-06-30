import type { Config } from '../../core/schemas/config.js';
import {
  commandTokensAfterInterpreter,
  isPathLike,
  isRepoLocal,
  isBareCommandResolvedInsideProject,
  isPackageManagerScriptInvocation,
  isShellEvaluatedPromptArg,
} from '../../core/trust/path-classification.js';
import { stripProfileMetadata } from '../../core/config/accessors/implementer-profiles.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
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
  const tokens = [...parseShellCommand(command), ...args];
  const executable = tokens[0];
  if (executable && isBareCommandResolvedInsideProject(executable, projectDir)) return true;
  if (isPackageManagerScriptInvocation(tokens)) return true;

  const checkTokens = commandTokensAfterInterpreter(tokens);
  for (const token of checkTokens) {
    const candidate = token.startsWith('-') ? flagValue(token) : token;
    if (candidate === null) continue;
    if (tokenIsRepoLocalExecutable(candidate, projectDir)) return true;
  }
  return false;
}

export interface RunnerTrustViolation {
  label: string;
  command: string;
}

export interface RunnerTrustResult {
  untrustedCommands: string[];
  violations: RunnerTrustViolation[];
}

type CommandRunner = Extract<
  Config['planner'] | Config['implementer'],
  { kind: 'shell' | 'agent' }
>;

function commandDisplay(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

function collectCommandRunnerViolations(
  label: string,
  runner: CommandRunner,
  projectDir: string,
): RunnerTrustViolation[] {
  const args = runner.args ?? [];
  const command = commandDisplay(runner.command, args);
  const violations: RunnerTrustViolation[] = [];

  if (commandHasRepoLocalPaths(runner.command, args, projectDir)) {
    violations.push({ label, command });
  }
  if (runner.kind === 'agent' && isShellEvaluatedPromptArg(runner.command, args)) {
    violations.push({ label, command });
  }

  return violations;
}

function commandRunnerViolations(config: Config, projectDir: string): RunnerTrustViolation[] {
  const violations: RunnerTrustViolation[] = [];

  for (const role of ['planner', 'implementer'] as const) {
    const runner = config[role];
    if (runner.kind !== 'shell' && runner.kind !== 'agent') continue;
    violations.push(...collectCommandRunnerViolations(role, runner, projectDir));
  }

  for (const [name, profile] of Object.entries(config.implementerProfiles?.profiles ?? {})) {
    const runner = stripProfileMetadata(profile);
    if (runner.kind !== 'shell' && runner.kind !== 'agent') continue;
    violations.push(
      ...collectCommandRunnerViolations(`implementer profile ${name}`, runner, projectDir),
    );
  }

  return violations;
}

export function checkRunnerTrust(config: Config, projectDir: string): RunnerTrustResult {
  const violations = commandRunnerViolations(config, projectDir);
  return { untrustedCommands: violations.map((violation) => violation.command), violations };
}

export function rejectUntrustedRunners(
  config: Config,
  projectDir: string,
  allowRepoRunners: boolean,
): void {
  const { violations } = checkRunnerTrust(config, projectDir);
  if (violations.length === 0) return;

  if (allowRepoRunners) return;

  const cmds = violations.map((v) => `  ${v.label}: ${v.command}`).join('\n');
  throw error(
    'runner-not-trusted',
    `Refusing to execute untrusted runner commands from project config:\n${cmds}\n` +
      `These commands can execute project-local code or shell-evaluate prompt text. ` +
      `Re-run with --allow-repo-runners to trust them, or use system-installed commands instead.`,
    { commands: violations.map((violation) => violation.command) },
  );
}

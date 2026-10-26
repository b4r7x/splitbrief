import type { Config } from '../../core/schemas/config.js';
import {
  isCustomCommandRunner,
  type CustomCommandRunner,
} from '../../core/config/custom-commands.js';
import { findConfiguredCustomCommand } from '../../core/config/custom-command-catalog.js';
import { argvIsRepoLocal } from '../../core/trust/command-string-classification.js';
import { stripProfileMetadata } from '../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { error } from '../../utils/error.js';

function commandHasRepoLocalPaths(
  command: string,
  args: readonly string[],
  projectDir: string,
): boolean {
  return argvIsRepoLocal([...parseShellCommand(command), ...args], projectDir);
}

export interface RunnerTrustViolation {
  label: string;
  command: string;
}

export interface RunnerTrustResult {
  violations: RunnerTrustViolation[];
}

function commandDisplay(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

function hasConfiguredCustomCommand(runner: CustomCommandRunner, config: Config): boolean {
  return findConfiguredCustomCommand(config, runner) !== undefined;
}

function collectCommandRunnerViolations(
  label: string,
  runner: CustomCommandRunner,
  projectDir: string,
): RunnerTrustViolation[] {
  const args = runner.args ?? [];
  if (!commandHasRepoLocalPaths(runner.command, args, projectDir)) return [];
  return [{ label, command: commandDisplay(runner.command, args) }];
}

function commandRunnerViolations(config: Config, projectDir: string): RunnerTrustViolation[] {
  const violations: RunnerTrustViolation[] = [];

  const reviewer = resolveReviewerRunner(config);
  const seats = [
    ['planner', config.planner],
    ['implementer', config.implementer],
    ...(reviewer.source === 'configured' ? [['reviewer', reviewer.runner] as const] : []),
  ] as const;
  for (const [label, runner] of seats) {
    if (!isCustomCommandRunner(runner)) continue;
    if (hasConfiguredCustomCommand(runner, config)) continue;
    violations.push(...collectCommandRunnerViolations(label, runner, projectDir));
  }

  for (const [name, profile] of Object.entries(config.implementerProfiles?.profiles ?? {})) {
    const runner = stripProfileMetadata(profile);
    if (!isCustomCommandRunner(runner)) continue;
    if (hasConfiguredCustomCommand(runner, config)) continue;
    violations.push(
      ...collectCommandRunnerViolations(`implementer profile ${name}`, runner, projectDir),
    );
  }

  return violations;
}

export function checkRunnerTrust(config: Config, projectDir: string): RunnerTrustResult {
  return { violations: commandRunnerViolations(config, projectDir) };
}

export function rejectUntrustedRunners(options: {
  config: Config;
  projectDir: string;
  allowRepoRunners: boolean;
}): void {
  const { violations } = checkRunnerTrust(options.config, options.projectDir);
  if (violations.length === 0) return;

  if (options.allowRepoRunners) return;

  const cmds = violations.map((v) => `  ${v.label}: ${v.command}`).join('\n');
  throw error(
    'runner-not-trusted',
    `Refusing to execute untrusted runner commands from project config:\n${cmds}\n` +
      `These commands can execute project-local code or shell-evaluate prompt text. ` +
      `Re-run with --allow-repo-runners to trust them, or use system-installed commands instead.`,
    { commands: violations.map((violation) => violation.command) },
  );
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { findAffectedTestFile } from '../../../core/validation/test-discovery.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars } from '../../../utils/truncate.js';
import { detectProjectLanguage } from '../../../core/project-meta.js';
import { detectValidationHeuristic } from './heuristic.js';

const MAX_VALIDATION_COMMAND_CHARS = 240;

export type CommandField = 'typecheckCommand' | 'lintCommand' | 'testCommand';
export type CommandSource = 'config' | 'discovered' | 'heuristic' | 'default';

export interface ResolvedCommand {
  cmd: string;
  args: string[];
  source: CommandSource;
}

export function resolveCommand(
  field: CommandField,
  config: Config,
  discovered: DiscoveredValidation | undefined,
  heuristic: DiscoveredValidation | null,
  fallback: ResolvedCommand | null,
): ResolvedCommand | null {
  for (const [source, value] of [
    ['config', config.validation[field]] as const,
    ['discovered', discovered?.[field]] as const,
    ['heuristic', heuristic?.[field]] as const,
  ]) {
    if (value) {
      const parts = parseShellCommand(value);
      const cmd = parts[0];
      if (!cmd) continue;
      return { cmd, args: parts.slice(1), source };
    }
  }
  return fallback;
}

function resolveTestPattern(
  config: Config,
  discovered: DiscoveredValidation | undefined,
  heuristic: DiscoveredValidation | null,
): string | undefined {
  return (
    config.validation.testPattern ?? discovered?.testPattern ?? heuristic?.testPattern ?? undefined
  );
}

type TestTarget = { run: true; target?: string | undefined } | { run: false; skipReason: string };

export function resolveTestTarget(
  resolved: ResolvedCommand,
  task: Task,
  projectDir: string,
  config: Config,
  discovered: DiscoveredValidation | undefined,
  heuristic: DiscoveredValidation | null,
): TestTarget {
  if (resolved.source !== 'default') return { run: true };
  const testPattern = resolveTestPattern(config, discovered, heuristic);
  const testFile = findAffectedTestFile(task.file, projectDir, testPattern);
  if (testFile) return { run: true, target: testFile };
  return { run: false, skipReason: 'no affected test file found' };
}

export function resolveValidationDisplayCommand(
  field: CommandField,
  config: Config,
  discovered: DiscoveredValidation | undefined,
  projectDir: string,
): string | null {
  const heuristic = detectValidationHeuristic(projectDir);
  const chain = [config.validation[field], discovered?.[field], heuristic?.[field]];
  for (const value of chain) {
    if (value) return value;
  }
  if (field === 'typecheckCommand') {
    return isTypeScriptProject(projectDir) ? 'npx tsc --noEmit' : null;
  }
  if (field === 'testCommand') return 'npm test';
  return null;
}

export function isTypeScriptProject(projectDir: string): boolean {
  if (existsSync(join(projectDir, 'tsconfig.json'))) return true;
  return detectProjectLanguage(projectDir) === 'typescript';
}

export function typecheckDefaultCommand(projectDir: string): ResolvedCommand | null {
  return isTypeScriptProject(projectDir)
    ? { cmd: 'npx', args: ['tsc', '--noEmit'], source: 'default' }
    : null;
}

export function formatValidationCommand(cmd: string, args: string[]): string {
  return redactSecrets(truncateByChars([cmd, ...args].join(' '), MAX_VALIDATION_COMMAND_CHARS));
}

import { relative } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import { taskFiles } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { findAffectedTestFiles } from '../../../core/validation/stacks/registry.js';
import type { Stack } from '../../../core/validation/stacks/types.js';
import type { ResolvedCommand } from '../../../core/validation/stage-command.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars } from '../../../utils/truncate.js';

const MAX_VALIDATION_COMMAND_CHARS = 240;

type TestTarget = { run: true; targets: string[] } | { run: false; skipReason: string };

export function resolveTestTarget(opts: {
  resolved: ResolvedCommand;
  task: Task;
  projectDir: string;
  config: Config;
  discovered: DiscoveredValidation | undefined;
  stack: Stack | null;
}): TestTarget {
  const { resolved, task, projectDir, config, discovered, stack } = opts;
  const narrows =
    resolved.source === 'default' || (resolved.source === 'manifest' && stack !== null);
  if (!narrows || stack === null) return { run: true, targets: [] };
  const testPattern = config.validation.testPattern ?? discovered?.testPattern;
  const targets: string[] = [];
  for (const file of taskFiles(task)) {
    for (const found of findAffectedTestFiles(file, projectDir, stack, testPattern)) {
      const target = relative(projectDir, found);
      if (!targets.includes(target)) targets.push(target);
    }
  }
  if (targets.length === 0) return { run: false, skipReason: 'no affected test file found' };
  return { run: true, targets };
}

export function formatValidationCommand(cmd: string, args: string[]): string {
  return redactSecrets(truncateByChars([cmd, ...args].join(' '), MAX_VALIDATION_COMMAND_CHARS));
}

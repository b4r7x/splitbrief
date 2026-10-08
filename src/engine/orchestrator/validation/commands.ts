import { relative } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { findAffectedTestFiles } from '../../../core/validation/stacks/registry.js';
import type { Stack } from '../../../core/validation/stacks/types.js';
import type { ResolvedCommand } from '../../../core/validation/stage-command.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars } from '../../../utils/truncate.js';

const MAX_VALIDATION_COMMAND_CHARS = 240;

type TestTarget = { run: true; targets: string[] } | { run: false; skipReason: string };

/**
 * The test files a planner `test` check runs. A command the stack can narrow takes the files it
 * affects; any other command runs as written.
 */
export function resolveTestTarget(opts: {
  resolved: ResolvedCommand;
  files: readonly string[];
  projectDir: string;
  config: Config;
  discovered: DiscoveredValidation | undefined;
  stack: Stack | null;
}): TestTarget {
  const { resolved, projectDir, config, discovered, stack } = opts;
  const narrows =
    resolved.source === 'default' || (resolved.source === 'manifest' && stack !== null);
  if (!narrows || stack === null || stack.narrowing.kind === 'none') {
    return { run: true, targets: [] };
  }
  const testPattern = config.validation.testPattern ?? discovered?.testPattern;
  const targets: string[] = [];
  for (const file of new Set(opts.files)) {
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

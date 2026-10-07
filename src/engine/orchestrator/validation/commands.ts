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

export type TestTargetMode = 'related' | 'check' | 'full';

/** The tests of the brief's declared files and of every file the attempt changed. */
export function resolveTestTarget(opts: {
  resolved: ResolvedCommand;
  task: { suggestedFiles: readonly string[] };
  changedFiles: readonly string[];
  projectDir: string;
  config: Config;
  discovered: DiscoveredValidation | undefined;
  stack: Stack | null;
  mode?: TestTargetMode | undefined;
}): TestTarget {
  const { resolved, task, projectDir, config, discovered, stack } = opts;
  if (opts.mode === 'full') return { run: true, targets: [] };
  const narrows =
    resolved.source === 'default' || (resolved.source === 'manifest' && stack !== null);
  if (!narrows || stack === null || stack.narrowing.kind === 'none') {
    if (opts.mode === 'check') return { run: true, targets: [] };
    return {
      run: false,
      skipReason: 'the test command cannot select related tests; the pre-review full suite runs it',
    };
  }
  const testPattern = config.validation.testPattern ?? discovered?.testPattern;
  const targets: string[] = [];
  for (const file of new Set([...task.suggestedFiles, ...opts.changedFiles])) {
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

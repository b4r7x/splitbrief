import type { Task } from '../../core/types/state-actions.js';
import type { Config } from '../../core/types/config-options.js';
import type { ValidationResult } from '../../core/types/summary.js';
import type { ValidationStages, OrchestratorCallbacks } from '../../core/types/events.js';
import { runCommand } from '../../lib/process/spawn.js';
import { isENOENT } from '../../lib/process/errors.js';
import { emitValidation } from './events.js';
import { truncateByLines } from '../../utils/truncate.js';
import { parseCommand, detectLinter, findAffectedTestFile } from './validator-internal.js';

const MAX_ERROR_LINES = 20;

async function runValidationStep(opts: {
  stage: ValidationResult['stage'];
  cmd: string;
  args: string[];
  cwd: string;
  errorSource: 'stderr' | 'stdout';
}): Promise<ValidationResult> {
  const { stage, cmd, args, cwd, errorSource: errorSourcePreference } = opts;
  try {
    const { stdout, stderr, code } = await runCommand(cmd, args, { cwd });

    if (code === 127) {
      return { passed: true, stage, output: `${cmd} not found, skipping ${stage}` };
    }

    const result: ValidationResult = { passed: code === 0, stage, output: stdout };
    if (code !== 0) {
      const primary = errorSourcePreference === 'stderr' ? stderr : stdout;
      const fallback = errorSourcePreference === 'stderr' ? stdout : stderr;
      result.error = (primary || fallback).trim();
    }
    return result;
  } catch (err: unknown) {
    if (isENOENT(err)) {
      return { passed: true, stage, output: `${cmd} not found, skipping ${stage}` };
    }
    throw err;
  }
}

async function validateTask(
  task: Task,
  projectDir: string,
  config: Config,
  onStageComplete?: (stages: ValidationStages) => void,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const stages = { tsc: false, lint: false, test: false };

  if (config.validation.typecheck) {
    const result = await runValidationStep({ stage: 'tsc', cmd: 'npx', args: ['tsc', '--noEmit'], cwd: projectDir, errorSource: 'stderr' });
    results.push(result);
    if (!result.passed) return results;
    stages.tsc = true;
    onStageComplete?.(stages);
  }

  if (config.validation.lint) {
    const linter = detectLinter(projectDir);

    if (linter) {
      const args = linter === 'eslint'
        ? ['eslint', '--', task.file]
        : ['biome', 'check', '--', task.file];
      const result = await runValidationStep({ stage: 'lint', cmd: 'npx', args, cwd: projectDir, errorSource: 'stdout' });
      results.push(result);
      if (!result.passed) return results;
      stages.lint = true;
      onStageComplete?.(stages);
    }
  }

  if (config.validation.test) {
    const testFile = findAffectedTestFile(task.file, projectDir);
    if (testFile) {
      const testCommand = config.validation.testCommand || 'npm test';
      const parts = parseCommand(testCommand);
      const cmd = parts[0] ?? 'npm';
      const result = await runValidationStep({ stage: 'test', cmd, args: [...parts.slice(1), '--', testFile], cwd: projectDir, errorSource: 'stderr' });
      results.push(result);
      if (!result.passed) return results;
      stages.test = true;
      onStageComplete?.(stages);
    }
  }

  return results;
}

export async function runValidationWithEvents(
  task: Task,
  projectDir: string,
  config: Config,
  callbacks: OrchestratorCallbacks,
): Promise<ValidationResult[]> {
  const startTime = Date.now();
  emitValidation(callbacks, { phase: 'start' });
  const results = await validateTask(task, projectDir, config, (stages) => {
    emitValidation(callbacks, { phase: 'progress', stages, startTime });
  });
  emitValidation(callbacks, { phase: 'result', results, startTime });
  return results;
}

export function formatValidationError(results: ValidationResult[]): string {
  const failed = results.find((r) => !r.passed);
  if (!failed) return '';

  const errorLines = truncateByLines(failed.error || '', MAX_ERROR_LINES);

  return [
    'Your previous code had an error. Fix it.',
    `Error type: ${failed.stage}`,
    `Error message: ${errorLines}`,
    'Fix the error and output the complete corrected file.',
  ].join('\n');
}

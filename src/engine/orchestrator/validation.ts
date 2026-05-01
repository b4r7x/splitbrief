import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskId } from '../../core/schemas/task.js';
import type { Config } from '../../core/schemas/config.js';
import type { ValidationStages } from '../events/types.js';
import type { EventBus } from '../events/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import { runCommand } from '../../lib/process/spawn.js';
import { isENOENT } from '../../lib/process/errors.js';
import { publishValidation } from './events.js';
import { truncateByLines } from '../../utils/truncate.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { createTestFileFinder } from '../../core/validation/test-discovery.js';

export interface ValidationResult {
  passed: boolean;
  stage: 'tsc' | 'lint' | 'test';
  error?: string | undefined;
  output?: string | undefined;
}

const MAX_ERROR_LINES = 20;

export type Linter = 'eslint' | 'biome' | null;

export interface Validator {
  detectLinter: (projectDir: string) => Linter;
  findAffectedTestFile: (taskFile: string, projectDir: string) => string | null;
  runValidation: (
    task: Task,
    projectDir: string,
    config: Config,
    bus: EventBus,
    phase: Phase,
    taskId: TaskId,
  ) => Promise<ValidationResult[]>;
}

export function createValidator(): Validator {
  const linterCache = new Map<string, Linter>();
  const findAffectedTestFile = createTestFileFinder();

  function detectLinter(projectDir: string): Linter {
    if (linterCache.has(projectDir)) return linterCache.get(projectDir) ?? null;

    const eslintPatterns = [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
    ];

    let detectedLinter: Linter = null;
    for (const pattern of eslintPatterns) {
      if (existsSync(join(projectDir, pattern))) { detectedLinter = 'eslint'; break; }
    }

    if (!detectedLinter && existsSync(join(projectDir, 'biome.json'))) detectedLinter = 'biome';

    linterCache.set(projectDir, detectedLinter);
    return detectedLinter;
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
        const parts = parseShellCommand(testCommand);
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

  async function runValidation(
    task: Task,
    projectDir: string,
    config: Config,
    bus: EventBus,
    phase: Phase,
    taskId: TaskId,
  ): Promise<ValidationResult[]> {
    const startTime = Date.now();
    publishValidation(bus, phase, taskId, { phase: 'start' });
    const results = await validateTask(task, projectDir, config, (stages) => {
      publishValidation(bus, phase, taskId, { phase: 'progress', stages, startTime });
    });
    publishValidation(bus, phase, taskId, { phase: 'result', results, startTime });
    return results;
  }

  return { detectLinter, findAffectedTestFile, runValidation };
}

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

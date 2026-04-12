import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { Task, Config, ValidationResult, ValidationStages, OrchestratorCallbacks } from '../../types.js';
import { runCommand, isENOENT } from '../../utils/process.js';
import { emitValidationStart, emitValidationProgress, emitValidationResult } from './events.js';

const MAX_ERROR_LINES = 20;

let cachedLinter: { dir: string; linter: 'eslint' | 'biome' | null } | null = null;

export function detectLinter(projectDir: string): 'eslint' | 'biome' | null {
  if (cachedLinter?.dir === projectDir) return cachedLinter.linter;

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

  let detectedLinter: 'eslint' | 'biome' | null = null;
  for (const pattern of eslintPatterns) {
    if (existsSync(join(projectDir, pattern))) { detectedLinter = 'eslint'; break; }
  }

  if (!detectedLinter && existsSync(join(projectDir, 'biome.json'))) detectedLinter = 'biome';

  cachedLinter = { dir: projectDir, linter: detectedLinter };
  return detectedLinter;
}


export function findAffectedTestFile(taskFile: string, projectDir: string): string | null {
  const dir = dirname(taskFile);
  const name = basename(taskFile).replace(/\.(ts|tsx|js|jsx)$/, '');

  const candidates = [
    join(projectDir, dir, `${name}.test.ts`),
    join(projectDir, dir, `${name}.test.tsx`),
    join(projectDir, dir.replace(/^src/, 'tests'), `${name}.test.ts`),
    join(projectDir, dir.replace(/^src/, 'test'), `${name}.test.ts`),
    join(projectDir, dir.replace(/^src/, 'tests'), `${name}.test.tsx`),
    join(projectDir, dir.replace(/^src/, 'test'), `${name}.test.tsx`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
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
      const parts = testCommand.split(/\s+/);
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
  emitValidationStart(callbacks);
  const results = await validateTask(task, projectDir, config, (stages) => {
    emitValidationProgress(callbacks, stages, startTime);
  });
  emitValidationResult(callbacks, results, startTime);
  return results;
}

export function formatValidationError(results: ValidationResult[]): string {
  const failed = results.find((r) => !r.passed);
  if (!failed) return '';

  const errorLines = (failed.error || '').split('\n').slice(0, MAX_ERROR_LINES).join('\n');

  return [
    'Your previous code had an error. Fix it.',
    `Error type: ${failed.stage}`,
    `Error message: ${errorLines}`,
    'Fix the error and output the complete corrected file.',
  ].join('\n');
}

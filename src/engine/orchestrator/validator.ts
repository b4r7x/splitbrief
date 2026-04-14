import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { Task, Config, ValidationResult, ValidationStages, OrchestratorCallbacks } from '../../types.js';
import { runCommand } from '../../utils/process.js';
import { isENOENT } from '../../utils/process-errors.js';
import { emitValidationStart, emitValidationProgress, emitValidationResult } from './events.js';

const MAX_ERROR_LINES = 20;

/** Split a shell-like command string into tokens, respecting quoted substrings. */
export function parseCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const linterCache = new Map<string, 'eslint' | 'biome' | null>();
const testFileCache = new Map<string, string | null>();

export function detectLinter(projectDir: string): 'eslint' | 'biome' | null {
  if (linterCache.has(projectDir)) return linterCache.get(projectDir) as 'eslint' | 'biome' | null;

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

  linterCache.set(projectDir, detectedLinter);
  return detectedLinter;
}


export function findAffectedTestFile(taskFile: string, projectDir: string): string | null {
  const cacheKey = `${projectDir}::${taskFile}`;
  if (testFileCache.has(cacheKey)) return testFileCache.get(cacheKey) ?? null;

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
    if (existsSync(candidate)) {
      testFileCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  testFileCache.set(cacheKey, null);
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

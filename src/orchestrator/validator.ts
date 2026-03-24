import { existsSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import type { Task, Config, ValidationResult } from '../types.js';
import { runCommand } from '../utils/process.js';

export function detectLinter(projectDir: string): 'eslint' | 'biome' | null {
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

  for (const pattern of eslintPatterns) {
    if (existsSync(join(projectDir, pattern))) return 'eslint';
  }

  if (existsSync(join(projectDir, 'biome.json'))) return 'biome';

  return null;
}

export function findAffectedTestFile(taskFile: string, projectDir: string): string | null {
  const rel = relative(projectDir, join(projectDir, taskFile));
  const dir = dirname(rel);
  const name = basename(rel).replace(/\.(ts|tsx|js|jsx)$/, '');

  const candidates = [
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

export async function validateTask(
  task: Task,
  projectDir: string,
  config: Config,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  if (config.validation.typecheck) {
    try {
      const { stdout, stderr, code } = await runCommand('npx', ['tsc', '--noEmit'], {
        cwd: projectDir,
      });

      if (code === 127) {
        results.push({ passed: true, stage: 'typecheck', output: 'tsc not found, skipping typecheck' });
      } else {
        const result: ValidationResult = {
          passed: code === 0,
          stage: 'typecheck',
          output: stdout,
        };
        if (code !== 0) {
          result.error = (stderr || stdout).trim();
        }
        results.push(result);
        if (!result.passed) return results;
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        results.push({ passed: true, stage: 'typecheck', output: 'tsc not found, skipping typecheck' });
      } else {
        throw err;
      }
    }
  }

  if (config.validation.lint) {
    const linter = detectLinter(projectDir);

    if (linter === 'eslint') {
      try {
        const { stdout, stderr, code } = await runCommand('npx', ['eslint', task.file], {
          cwd: projectDir,
        });

        if (code === 127) {
          results.push({ passed: true, stage: 'lint', output: 'eslint not found, skipping lint' });
        } else {
          const result: ValidationResult = {
            passed: code === 0,
            stage: 'lint',
            output: stdout,
          };
          if (code !== 0) {
            result.error = (stdout || stderr).trim();
          }
          results.push(result);
          if (!result.passed) return results;
        }
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          results.push({ passed: true, stage: 'lint', output: 'eslint not found, skipping lint' });
        } else {
          throw err;
        }
      }
    } else if (linter === 'biome') {
      try {
        const { stdout, stderr, code } = await runCommand('npx', ['biome', 'check', task.file], {
          cwd: projectDir,
        });

        if (code === 127) {
          results.push({ passed: true, stage: 'lint', output: 'biome not found, skipping lint' });
        } else {
          const result: ValidationResult = {
            passed: code === 0,
            stage: 'lint',
            output: stdout,
          };
          if (code !== 0) {
            result.error = (stdout || stderr).trim();
          }
          results.push(result);
          if (!result.passed) return results;
        }
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          results.push({ passed: true, stage: 'lint', output: 'biome not found, skipping lint' });
        } else {
          throw err;
        }
      }
    }
  }

  if (config.validation.test) {
    const testFile = findAffectedTestFile(task.file, projectDir);

    if (testFile) {
      const testCommand = config.validation.testCommand || 'npm test';
      const parts = testCommand.split(/\s+/);
      const cmd = parts[0];
      const args = [...parts.slice(1), '--', testFile];

      try {
        const { stdout, stderr, code } = await runCommand(cmd, args, {
          cwd: projectDir,
        });

        if (code === 127) {
          results.push({ passed: true, stage: 'test', output: `Test command "${testCommand}" not found, skipping tests` });
        } else {
          const result: ValidationResult = {
            passed: code === 0,
            stage: 'test',
            output: stdout,
          };
          if (code !== 0) {
            result.error = (stderr || stdout).trim();
          }
          results.push(result);
        }
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          results.push({ passed: true, stage: 'test', output: `Test command "${testCommand}" not found, skipping tests` });
        } else {
          throw err;
        }
      }
    }
  }

  return results;
}

export function formatValidationError(results: ValidationResult[]): string {
  const failed = results.find((r) => !r.passed);
  if (!failed) return '';

  const errorLines = (failed.error || '').split('\n').slice(0, 20).join('\n');

  return [
    'Your previous code had an error. Fix it.',
    `Error type: ${failed.stage}`,
    `Error message: ${errorLines}`,
    'Fix the error and output the complete corrected file.',
  ].join('\n');
}

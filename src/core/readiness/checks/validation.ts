import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';

export interface PackageScriptsReadinessInput {
  packageJsonExists: boolean;
  scripts: Record<string, string>;
  parseError?: string | undefined;
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

export function buildValidationChecks(
  config: Config,
  packageScripts: PackageScriptsReadinessInput,
  projectDir: string,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [{
    id: 'validation.configured',
    severity: 'info',
    summary: `Validation: typecheck ${onOff(config.validation.typecheck)}, lint ${onOff(config.validation.lint)}, test ${onOff(config.validation.test)}.`,
    details: [`Test command: ${config.validation.testCommand}`],
    metadata: {
      typecheck: config.validation.typecheck,
      lint: config.validation.lint,
      test: config.validation.test,
      testCommand: config.validation.testCommand,
    },
  }];

  const disabled = [
    !config.validation.typecheck ? 'typecheck' : null,
    !config.validation.lint ? 'lint' : null,
    !config.validation.test ? 'test' : null,
  ].filter((value): value is string => value !== null);

  if (disabled.length > 0) {
    checks.push({
      id: 'validation.disabled',
      severity: 'warning',
      summary: `Validation checks disabled: ${disabled.join(', ')}.`,
      fix: 'Enable validation checks in .diptych/config.yaml when the project supports them.',
    });
  }

  if (config.validation.lint && !hasKnownLinterConfig(projectDir)) {
    checks.push({
      id: 'validation.lint-unknown',
      severity: 'info',
      summary: 'No ESLint or Biome config detected.',
      details: ['Task validation skips lint when no supported linter config exists.'],
    });
  }

  if (config.validation.test) {
    const testScriptWarning = testCommandWarning(config.validation.testCommand, packageScripts);
    if (testScriptWarning) checks.push(testScriptWarning);
  }

  if (packageScripts.parseError) {
    checks.push({
      id: 'validation.package-json-invalid',
      severity: 'warning',
      summary: 'package.json could not be parsed for validation posture.',
      details: [packageScripts.parseError],
    });
  }

  return checks;
}

function testCommandWarning(
  command: string,
  packageScripts: PackageScriptsReadinessInput,
): ReadinessCheck | null {
  const parts = parseShellCommand(command);
  const commandName = parts[0];
  if (commandName !== 'npm') return null;

  const scriptName = parts[1] === 'run' ? parts[2] : parts[1] === 'test' ? 'test' : undefined;
  if (!scriptName) return null;

  if (!packageScripts.packageJsonExists) {
    return {
      id: 'validation.package-json-missing',
      severity: 'warning',
      summary: `Test command "${command}" references npm scripts, but package.json was not found.`,
      fix: 'Add package.json or update validation.testCommand.',
    };
  }

  if (!Object.hasOwn(packageScripts.scripts, scriptName)) {
    return {
      id: 'validation.test-script-missing',
      severity: 'warning',
      summary: `Test command "${command}" references missing package script "${scriptName}".`,
      fix: 'Add the package script or update validation.testCommand.',
    };
  }

  return null;
}

function hasKnownLinterConfig(projectDir: string): boolean {
  const files = [
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
    'biome.json',
  ];
  return files.some(file => existsSync(join(projectDir, file)));
}

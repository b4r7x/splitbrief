import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { runCommand } from '../../../lib/process/spawn.js';
import { isENOENT, processError } from '../../../lib/process/errors.js';
import { detectProjectLanguage } from '../../project-meta.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';

const DEFAULT_VALIDATION_TIMEOUT_MS = 600_000;
const MISSING_SUBCOMMAND_EXIT_CODE = 101;

function isMissingSubcommand(code: number | null, stderr: string): boolean {
  return code === MISSING_SUBCOMMAND_EXIT_CODE && /no such command/i.test(stderr);
}

const LANGUAGE_TEST_COMMANDS: Record<string, string> = {
  rust: 'cargo test',
  go: 'go test ./...',
  python: 'pytest',
};

function resolveReadinessTestCommand(config: Config, projectDir: string): string {
  if (config.validation.testCommand) return config.validation.testCommand;
  const language = detectProjectLanguage(projectDir);
  return (language && LANGUAGE_TEST_COMMANDS[language]) ?? 'npm test';
}

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
  const checks: ReadinessCheck[] = [
    {
      id: 'validation.configured',
      severity: 'info',
      summary: `Validation: typecheck ${onOff(config.validation.typecheck)}, lint ${onOff(config.validation.lint)}, test ${onOff(config.validation.test)}.`,
      details: [`Test command: ${resolveReadinessTestCommand(config, projectDir)}`],
      metadata: {
        typecheck: config.validation.typecheck,
        lint: config.validation.lint,
        test: config.validation.test,
        testCommand: resolveReadinessTestCommand(config, projectDir),
      },
    },
  ];

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

  if (
    config.validation.lint &&
    !config.validation.lintCommand &&
    !hasKnownLinterConfig(projectDir)
  ) {
    const language = detectProjectLanguage(projectDir);
    const isJsLike =
      language === undefined || language === 'javascript' || language === 'typescript';
    checks.push({
      id: 'validation.lint-unknown',
      severity: 'info',
      summary: 'No lint command configured or discovered.',
      details: [
        isJsLike
          ? 'Task validation skips the lint stage until a lintCommand is set or an ESLint/Biome config exists.'
          : `Lint config auto-discovery only covers JavaScript/TypeScript linters (ESLint, Biome), so the lint stage is skipped for this ${language} project until validation.lintCommand is set.`,
      ],
    });
  }

  if (config.validation.test) {
    const testScriptWarning = testCommandWarning(
      resolveReadinessTestCommand(config, projectDir),
      packageScripts,
    );
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

type ProbeStage = 'typecheck' | 'lint' | 'test';

function resolveProbeCommand(stage: ProbeStage, config: Config, projectDir: string): string | null {
  if (stage === 'typecheck') {
    if (config.validation.typecheckCommand) return config.validation.typecheckCommand;
    return isTypeScriptProject(projectDir) ? 'npx tsc --noEmit' : null;
  }
  if (stage === 'lint') {
    return config.validation.lintCommand ?? null;
  }
  return resolveReadinessTestCommand(config, projectDir);
}

function isTypeScriptProject(projectDir: string): boolean {
  if (existsSync(join(projectDir, 'tsconfig.json'))) return true;
  return detectProjectLanguage(projectDir) === 'typescript';
}

export async function probeValidationBaseline(
  config: Config,
  projectDir: string,
): Promise<ReadinessCheck[]> {
  const enabled: ProbeStage[] = [
    config.validation.typecheck ? 'typecheck' : null,
    config.validation.lint ? 'lint' : null,
    config.validation.test ? 'test' : null,
  ].filter((stage): stage is ProbeStage => stage !== null);

  const timeout = config.validation.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  const failing: string[] = [];

  for (const stage of enabled) {
    const command = resolveProbeCommand(stage, config, projectDir);
    if (!command) continue;
    const parts = parseShellCommand(command);
    const cmd = parts[0];
    if (!cmd) continue;
    try {
      await runCommand(cmd, parts.slice(1), { cwd: projectDir, timeout, label: `${stage} probe` });
    } catch (err) {
      if (isENOENT(err) || processError.isNotFound(err)) continue;
      if (processError.isExitCode(err) && isMissingSubcommand(err.data.code, err.data.stderr)) {
        continue;
      }
      failing.push(stage);
    }
  }

  if (failing.length === 0) return [];

  return [
    {
      id: 'validation.already-failing',
      severity: 'warning',
      summary: `Validation already failing before any task: ${failing.join(', ')}.`,
      details: [
        'These stages fail on the working tree as-is, so first-task failures here are not caused by the implementer.',
      ],
      fix: 'Fix the pre-existing validation failures, or disable the affected stages in .diptych/config.yaml.',
    },
  ];
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
  return files.some((file) => existsSync(join(projectDir, file)));
}

import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { shellQuoteArg } from '../../../utils/shell-quote.js';
import { resolveEndChecks } from '../../config/runtime/resolve.js';
import { readManifestCommands } from '../../validation/manifest-commands.js';
import { detectStack } from '../../validation/stacks/registry.js';
import { resolveTestCommand, type ResolvedCommand } from '../../validation/stage-command.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';

function commandText(resolved: ResolvedCommand): string {
  return [resolved.cmd, ...resolved.args].map(shellQuoteArg).join(' ');
}

export interface PackageScriptsReadinessInput {
  packageJsonExists: boolean;
  scripts: Record<string, string>;
  parseError?: string | undefined;
}

export function buildValidationChecks(
  config: Config,
  packageScripts: PackageScriptsReadinessInput,
  projectDir: string,
): ReadinessCheck[] {
  // The planner-discovered rung does not exist before the run starts, so readiness resolves the
  // same chain a test check does with `discovered` empty.
  const test = resolveTestCommand({
    config,
    manifest: readManifestCommands(projectDir),
    discovered: undefined,
    stack: detectStack(projectDir, config.validation.stack),
    projectDir,
  });
  const testCommand = test === null ? null : commandText(test);
  const endChecks = resolveEndChecks(config);

  const checks: ReadinessCheck[] = [
    {
      id: 'validation.configured',
      severity: 'info',
      summary: `End-of-run checks: ${endChecks ? 'on' : 'off'}.`,
      details: [
        endChecks
          ? 'Before each review the reviewer chooses the commands that verify the change, and SPLITBRIEF runs them.'
          : 'SPLITBRIEF runs no command before a review; only the plan checks run.',
        `Test check command: ${testCommand ?? 'none (unrecognised stack)'}`,
      ],
      metadata: { endChecks, testCommand },
    },
  ];

  if (!endChecks) {
    checks.push({
      id: 'validation.end-checks-off',
      severity: 'warning',
      summary: 'End-of-run checks are off: no command verifies the change before a review.',
      fix: 'Set validation.end_checks: true in .splitbrief/config.yaml, or turn End-of-run checks on in Settings.',
    });
  }

  if (testCommand !== null) {
    const testScriptWarning = testCommandWarning(testCommand, packageScripts);
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

import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { shellQuoteArg } from '../../../utils/shell-quote.js';
import { runCommand } from '../../../lib/process/spawn/run-command.js';
import { isENOENT, processError } from '../../../lib/process/errors.js';
import { readManifestCommands } from '../../validation/manifest-commands.js';
import { detectStack } from '../../validation/stacks/registry.js';
import {
  isMissingSubcommand,
  resolveStageCommand,
  type ResolvedCommand,
  type StageResolution,
} from '../../validation/stage-command.js';
import type { Config } from '../../schemas/config.js';
import { GATE_ORDER, STAGE_TIMEOUT_MS } from '../../pipeline-spec/gates.js';
import type { ReadinessCheck } from '../types.js';

// The planner-discovered rung does not exist before the run starts, so readiness
// resolves the same chain the run does with `discovered` empty.
function probeContext(config: Config, projectDir: string): Omit<StageResolution, 'stage'> {
  return {
    config,
    manifest: readManifestCommands(projectDir),
    discovered: undefined,
    stack: detectStack(projectDir, config.validation.stack),
    projectDir,
  };
}

function commandText(resolved: ResolvedCommand): string {
  return [resolved.cmd, ...resolved.args].map(shellQuoteArg).join(' ');
}

export interface PackageScriptsReadinessInput {
  packageJsonExists: boolean;
  scripts: Record<string, string>;
  parseError?: string | undefined;
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

// "lint on" must mean a lint stage will actually run; an enabled stage with no
// resolvable command is reported as skipped, not on.
function lintSegment(enabled: boolean, command: string | null): string {
  if (!enabled) return 'lint off';
  return command === null ? 'lint skipped (no lint command)' : 'lint on';
}

export function buildValidationChecks(
  config: Config,
  packageScripts: PackageScriptsReadinessInput,
  projectDir: string,
): ReadinessCheck[] {
  const context = probeContext(config, projectDir);
  const lint = resolveStageCommand({ stage: 'lint', ...context });
  const test = resolveStageCommand({ stage: 'test', ...context });
  const lintCommand = lint === null ? null : commandText(lint);
  const testCommand = test === null ? null : commandText(test);

  const checks: ReadinessCheck[] = [
    {
      id: 'validation.configured',
      severity: 'info',
      summary: `Validation: typecheck ${onOff(config.validation.typecheck)}, ${lintSegment(config.validation.lint, lintCommand)}, test ${onOff(config.validation.test)}.`,
      details: [`Test command: ${testCommand ?? 'none (unrecognised stack)'}`],
      metadata: {
        typecheck: config.validation.typecheck,
        lint: config.validation.lint,
        lintCommand: config.validation.lint ? lintCommand : null,
        test: config.validation.test,
        testCommand,
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
      fix: 'Enable validation checks in .splitbrief/config.yaml when the project supports them.',
    });
  }

  if (config.validation.lint && lintCommand === null) {
    const stack = context.stack;
    const isJsLike =
      stack === null || stack.language === 'typescript' || stack.language === 'javascript';
    checks.push({
      id: 'validation.lint-unknown',
      severity: 'info',
      summary: 'No lint command configured or discovered.',
      details: [
        isJsLike
          ? 'Task validation skips the lint stage until a lintCommand is set, a `lint` package script exists, or an ESLint/Biome config exists.'
          : `No ${stack.language} linter config was discovered, so the lint stage is skipped until validation.lintCommand is set.`,
      ],
    });
  }

  if (config.validation.test && testCommand !== null) {
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

export async function probeValidationBaseline(
  config: Config,
  projectDir: string,
): Promise<ReadinessCheck[]> {
  const enabled = GATE_ORDER.filter((stage) => config.validation[stage]);
  const context = probeContext(config, projectDir);

  const timeout = config.validation.timeoutMs ?? STAGE_TIMEOUT_MS;
  const failing: string[] = [];
  const probedCommands: string[] = [];

  for (const stage of enabled) {
    const resolved = resolveStageCommand({ stage, ...context });
    if (resolved === null) continue;
    probedCommands.push(`${stage}: ${commandText(resolved)}`);
    try {
      await runCommand(resolved.cmd, resolved.args, {
        cwd: projectDir,
        timeout,
        label: `${stage} probe`,
      });
    } catch (err) {
      if (isENOENT(err) || processError.isNotFound(err)) continue;
      if (
        processError.isExitCode(err) &&
        isMissingSubcommand(context.stack, err.data.code, err.data.stderr)
      ) {
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
        `Probed commands: ${probedCommands.join('; ')}.`,
        'These are the pre-run commands; during a run SPLITBRIEF may resolve different ones from planner discovery.',
        'These stages fail on the working tree as-is, so first-task failures here are not caused by the implementer.',
      ],
      fix: 'Fix the pre-existing validation failures, or disable the affected stages in .splitbrief/config.yaml.',
    },
  ];
}

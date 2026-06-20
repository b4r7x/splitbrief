import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../core/schemas/task.js';
import type { Config } from '../../core/schemas/config.js';
import type { ValidationStageCommands, ValidationStages } from '../events/types.js';
import type { EventBus } from '../events/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import { runCommand } from '../../lib/process/spawn.js';
import { isENOENT, processError } from '../../lib/process/errors.js';
import { publishValidation, publishWarning } from './events.js';
import { truncateByChars, truncateByLines, truncateByTailLines } from '../../utils/truncate.js';
import { redactSecrets } from '../../utils/redact.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { findAffectedTestFile } from '../../core/validation/test-discovery.js';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';
import { detectValidationHeuristic } from './validation-heuristic.js';
import { detectProjectLanguage } from '../../core/project-meta.js';
import { sanitizeDiscoveredValidation } from './planning/sanitize-discovered-validation.js';
import type { ValidationResult } from './validation-result.js';

const MAX_ERROR_LINES = 20;
const MAX_VALIDATION_COMMAND_CHARS = 240;
const DEFAULT_VALIDATION_TIMEOUT_MS = 600_000;
const MISSING_SUBCOMMAND_EXIT_CODE = 101;
export type ValidationCommandRunner = typeof runCommand;

function isMissingSubcommand(code: number | null, stderr: string): boolean {
  return code === MISSING_SUBCOMMAND_EXIT_CODE && /no such command/i.test(stderr);
}

function resolveValidationTimeout(config: Config): number {
  return config.validation.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
}

export type RunValidationOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  discoveredValidation?: DiscoveredValidation | undefined;
};

export type ValidationStage = ValidationResult['stage'];

export type PrimeBaselineOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  discoveredValidation?: DiscoveredValidation | undefined;
};

export interface Validator {
  primeBaseline: (opts: PrimeBaselineOptions) => Promise<void>;
  runValidation: (opts: RunValidationOptions) => Promise<ValidationResult[]>;
  getBaselineFailingStages?: (() => ReadonlySet<ValidationStage>) | undefined;
}

type ValidatorDeps = {
  runCommand?: ValidationCommandRunner | undefined;
  captureBaseline?: boolean | undefined;
};

type CommandField = 'typecheckCommand' | 'lintCommand' | 'testCommand';
type CommandSource = 'config' | 'discovered' | 'heuristic' | 'default';

interface ResolvedCommand {
  cmd: string;
  args: string[];
  source: CommandSource;
}

function resolveCommand(
  field: CommandField,
  config: Config,
  discovered: DiscoveredValidation | undefined,
  heuristic: DiscoveredValidation | null,
  fallback: ResolvedCommand | null,
): ResolvedCommand | null {
  for (const [source, value] of [
    ['config', config.validation[field]] as const,
    ['discovered', discovered?.[field]] as const,
    ['heuristic', heuristic?.[field]] as const,
  ]) {
    if (value) {
      const parts = parseShellCommand(value);
      const cmd = parts[0];
      if (!cmd) continue;
      return { cmd, args: parts.slice(1), source };
    }
  }
  return fallback;
}

function resolveTestPattern(
  config: Config,
  discovered: DiscoveredValidation | undefined,
  heuristic: DiscoveredValidation | null,
): string | undefined {
  return (
    config.validation.testPattern ?? discovered?.testPattern ?? heuristic?.testPattern ?? undefined
  );
}

type TestTarget = { run: true; target?: string | undefined } | { run: false; skipReason: string };

function resolveTestTarget(
  resolved: ResolvedCommand,
  task: Task,
  projectDir: string,
  config: Config,
  discovered: DiscoveredValidation | undefined,
  heuristic: DiscoveredValidation | null,
): TestTarget {
  if (resolved.source !== 'default') return { run: true };
  const testPattern = resolveTestPattern(config, discovered, heuristic);
  const testFile = findAffectedTestFile(task.file, projectDir, testPattern);
  if (testFile) return { run: true, target: testFile };
  return { run: false, skipReason: 'no affected test file found' };
}

export function resolveValidationDisplayCommand(
  field: CommandField,
  config: Config,
  discovered: DiscoveredValidation | undefined,
  projectDir: string,
): string | null {
  const heuristic = detectValidationHeuristic(projectDir);
  const chain = [config.validation[field], discovered?.[field], heuristic?.[field]];
  for (const value of chain) {
    if (value) return value;
  }
  if (field === 'typecheckCommand') {
    return isTypeScriptProject(projectDir) ? 'npx tsc --noEmit' : null;
  }
  if (field === 'testCommand') return 'npm test';
  return null;
}

function isTypeScriptProject(projectDir: string): boolean {
  if (existsSync(join(projectDir, 'tsconfig.json'))) return true;
  return detectProjectLanguage(projectDir) === 'typescript';
}

function skippedStage(stage: ValidationResult['stage'], reason: string): ValidationResult {
  return { passed: true, stage, skipped: true, output: `skipped ${stage}: ${reason}` };
}

interface ValidationProgress {
  stages: ValidationStages;
  activeStage?: ValidationStage | undefined;
  commands: ValidationStageCommands;
}

function typecheckDefaultCommand(projectDir: string): ResolvedCommand | null {
  return isTypeScriptProject(projectDir)
    ? { cmd: 'npx', args: ['tsc', '--noEmit'], source: 'default' }
    : null;
}

export function createValidator(deps: ValidatorDeps = {}): Validator {
  const commandRunner = deps.runCommand ?? runCommand;
  let baselineFailingStages: ReadonlySet<ValidationStage> | null = null;

  async function probeBaseline(
    task: Task,
    projectDir: string,
    config: Config,
    discovered: DiscoveredValidation | undefined,
    heuristic: DiscoveredValidation | null,
  ): Promise<Set<ValidationStage>> {
    const failing = new Set<ValidationStage>();
    const probeStage = async (
      stage: ValidationStage,
      resolved: ResolvedCommand | null,
      target?: string,
    ) => {
      if (!resolved) return;
      const args = target !== undefined ? [...resolved.args, '--', target] : resolved.args;
      const command = formatValidationCommand(resolved.cmd, args);
      const result = await runValidationStep({
        stage,
        cmd: resolved.cmd,
        args,
        source: resolved.source,
        cwd: projectDir,
        timeout: resolveValidationTimeout(config),
        runCommand: commandRunner,
        command,
      });
      if (!result.passed) failing.add(stage);
    };

    if (config.validation.typecheck) {
      await probeStage(
        'typecheck',
        resolveCommand(
          'typecheckCommand',
          config,
          discovered,
          heuristic,
          typecheckDefaultCommand(projectDir),
        ),
      );
    }
    if (config.validation.lint) {
      await probeStage('lint', resolveCommand('lintCommand', config, discovered, heuristic, null));
    }
    if (config.validation.test) {
      const resolved = resolveCommand('testCommand', config, discovered, heuristic, {
        cmd: 'npm',
        args: ['test'],
        source: 'default',
      });
      if (resolved) {
        const testTarget = resolveTestTarget(
          resolved,
          task,
          projectDir,
          config,
          discovered,
          heuristic,
        );
        if (testTarget.run) await probeStage('test', resolved, testTarget.target);
      }
    }
    return failing;
  }

  async function validateTask(
    task: Task,
    projectDir: string,
    config: Config,
    discovered: DiscoveredValidation | undefined,
    heuristic: DiscoveredValidation | null,
    onProgress?: (progress: ValidationProgress) => void,
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const stages: ValidationStages = { typecheck: false, lint: false, test: false };
    const commands: ValidationStageCommands = {};

    const runAndRecordStage = async (
      stage: ValidationResult['stage'],
      resolved: ResolvedCommand,
      target?: string,
    ): Promise<'continue' | 'stop'> => {
      const args = target !== undefined ? [...resolved.args, '--', target] : resolved.args;
      const command = formatValidationCommand(resolved.cmd, args);
      commands[stage] = command;
      onProgress?.({ stages: { ...stages }, activeStage: stage, commands: { ...commands } });
      const result = await runValidationStep({
        stage,
        cmd: resolved.cmd,
        args,
        source: resolved.source,
        cwd: projectDir,
        timeout: resolveValidationTimeout(config),
        runCommand: commandRunner,
        command,
      });
      results.push(result);
      if (!result.passed) return 'stop';
      stages[stage] = true;
      onProgress?.({ stages: { ...stages }, commands: { ...commands } });
      return 'continue';
    };

    if (config.validation.typecheck) {
      const resolved = resolveCommand(
        'typecheckCommand',
        config,
        discovered,
        heuristic,
        typecheckDefaultCommand(projectDir),
      );
      if (resolved) {
        if ((await runAndRecordStage('typecheck', resolved)) === 'stop') return results;
      } else {
        results.push(skippedStage('typecheck', 'no typecheck command resolved'));
      }
    }

    if (config.validation.lint) {
      const resolved = resolveCommand('lintCommand', config, discovered, heuristic, null);
      if (resolved) {
        if ((await runAndRecordStage('lint', resolved)) === 'stop') return results;
      } else {
        results.push(skippedStage('lint', 'no lint command resolved'));
      }
    }

    if (config.validation.test) {
      const resolved = resolveCommand('testCommand', config, discovered, heuristic, {
        cmd: 'npm',
        args: ['test'],
        source: 'default',
      });
      if (resolved) {
        const testTarget = resolveTestTarget(
          resolved,
          task,
          projectDir,
          config,
          discovered,
          heuristic,
        );
        if (testTarget.run) {
          if ((await runAndRecordStage('test', resolved, testTarget.target)) === 'stop') {
            return results;
          }
        } else {
          results.push(skippedStage('test', testTarget.skipReason));
        }
      }
    }

    return results;
  }

  async function primeBaseline(opts: PrimeBaselineOptions): Promise<void> {
    if (deps.captureBaseline !== true || baselineFailingStages !== null) return;
    const { task, projectDir, config, discoveredValidation } = opts;
    const heuristic = detectValidationHeuristic(projectDir);
    const sanitizedDiscovered = sanitizeDiscoveredValidation(discoveredValidation);
    baselineFailingStages = await probeBaseline(
      task,
      projectDir,
      config,
      sanitizedDiscovered,
      heuristic,
    );
  }

  async function runValidation(opts: RunValidationOptions): Promise<ValidationResult[]> {
    const { task, projectDir, config, bus, phase, discoveredValidation } = opts;
    const taskId = task.id;
    const startTime = Date.now();
    publishValidation({ bus: bus, phase: phase }, taskId, { phase: 'start' });
    const heuristic = detectValidationHeuristic(projectDir);
    const sanitizedDiscovered = sanitizeDiscoveredValidation(discoveredValidation);
    const results = await validateTask(
      task,
      projectDir,
      config,
      sanitizedDiscovered,
      heuristic,
      (progress) => {
        publishValidation({ bus: bus, phase: phase }, taskId, {
          phase: 'progress',
          stages: progress.stages,
          startTime,
          ...(progress.activeStage !== undefined && { activeStage: progress.activeStage }),
          commands: progress.commands,
        });
      },
    );
    publishValidation({ bus: bus, phase: phase }, taskId, { phase: 'result', results, startTime });
    if (results.length > 0 && results.every((r) => r.skipped)) {
      publishWarning(
        { bus: bus, phase: phase },
        `Task ${taskId} was not validated: every enabled validation stage was skipped (${results
          .map((r) => r.stage)
          .join(', ')}).`,
      );
    }
    return results;
  }

  return {
    primeBaseline,
    runValidation,
    getBaselineFailingStages: () => baselineFailingStages ?? new Set<ValidationStage>(),
  };
}

const MAX_VALIDATION_OUTPUT_CHARS = 4096;
const MAX_TEST_FAILURE_TAIL_LINES = 40;

function formatValidationCommand(cmd: string, args: string[]): string {
  return redactSecrets(truncateByChars([cmd, ...args].join(' '), MAX_VALIDATION_COMMAND_CHARS));
}

function sanitizeValidationOutput(text: string): string {
  return redactSecrets(truncateByChars(text, MAX_VALIDATION_OUTPUT_CHARS));
}

function selectFailureDetail(
  stage: ValidationResult['stage'],
  stdout: string,
  stderr: string,
): string {
  if (stage === 'test') {
    const combined = [stdout, stderr].filter((part) => part.trim().length > 0).join('\n');
    return truncateByTailLines(combined, MAX_TEST_FAILURE_TAIL_LINES).trim();
  }
  return (stderr || stdout).trim();
}

async function runValidationStep(opts: {
  stage: ValidationResult['stage'];
  cmd: string;
  args: string[];
  source: CommandSource;
  cwd: string;
  timeout: number;
  runCommand: ValidationCommandRunner;
  command: string;
}): Promise<ValidationResult> {
  const { stage, cmd, args, source, cwd, timeout, runCommand, command } = opts;
  try {
    const { stdout } = await runCommand(cmd, args, { cwd, timeout, label: `${stage} validation` });
    return { passed: true, stage, output: sanitizeValidationOutput(stdout), command };
  } catch (err: unknown) {
    if (isENOENT(err) || processError.isNotFound(err)) {
      if (source === 'config') {
        return {
          passed: false,
          stage,
          error: `Configured ${stage} command not found: ${cmd}`,
          output: '',
          command,
        };
      }
      return {
        passed: true,
        stage,
        skipped: true,
        output: `${cmd} not found, skipping ${stage}`,
        command,
      };
    }
    if (processError.isTimeout(err)) {
      return {
        passed: false,
        stage,
        error: sanitizeValidationOutput(err.message),
        output: '',
        command,
      };
    }
    if (processError.isExitCode(err)) {
      const { output, stderr } = err.data;
      if (source !== 'config' && isMissingSubcommand(err.data.code, String(stderr ?? ''))) {
        return {
          passed: true,
          stage,
          skipped: true,
          output: `${cmd} subcommand unavailable, skipping ${stage}`,
          command,
        };
      }
      const stdout = String(output ?? '');
      const errText = selectFailureDetail(stage, stdout, String(stderr ?? ''));
      return {
        passed: false,
        stage,
        output: sanitizeValidationOutput(stdout),
        error: sanitizeValidationOutput(errText),
        command,
      };
    }
    throw err;
  }
}

export function formatValidationError(
  results: ValidationResult[],
  baselineFailingStages?: ReadonlySet<ValidationStage>,
): string {
  const failed = results.find((r) => !r.passed);
  if (!failed) return '';

  const errorText = failed.error || failed.output || '';
  const errorLines =
    failed.stage === 'test'
      ? truncateByTailLines(errorText, MAX_ERROR_LINES)
      : truncateByLines(errorText, MAX_ERROR_LINES);
  const preExisting =
    baselineFailingStages !== undefined
      ? results.filter((r) => !r.passed && baselineFailingStages.has(r.stage)).length
      : 0;

  const header =
    preExisting > 0 && baselineFailingStages?.has(failed.stage)
      ? `${preExisting} pre-existing failure${preExisting === 1 ? '' : 's'} (not caused by this task). Fix the current error.`
      : 'Your previous code had an error. Fix it.';

  return [
    header,
    `Error type: ${failed.stage}`,
    `Error message: ${errorLines}`,
    'Fix the error and output the complete corrected file.',
  ].join('\n');
}

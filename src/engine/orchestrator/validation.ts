import type { Task } from '../../core/schemas/task.js';
import type { Config } from '../../core/schemas/config.js';
import type { ValidationStages } from '../events/types.js';
import type { EventBus } from '../events/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import { runCommand } from '../../lib/process/spawn.js';
import { isENOENT, processError } from '../../lib/process/errors.js';
import { publishValidation } from './events.js';
import { truncateByChars, truncateByLines } from '../../utils/truncate.js';
import { redactSecrets } from '../../utils/redact.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { findAffectedTestFile } from '../../core/validation/test-discovery.js';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';
import { detectValidationHeuristic } from './validation-heuristic.js';
import { sanitizeDiscoveredValidation } from './planning/sanitize-discovered-validation.js';
import type { ValidationResult } from './validation-result.js';

const MAX_ERROR_LINES = 20;
export type ValidationCommandRunner = typeof runCommand;

export type RunValidationOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  discoveredValidation?: DiscoveredValidation | undefined;
};

export interface Validator {
  runValidation: (opts: RunValidationOptions) => Promise<ValidationResult[]>;
}

type ValidatorDeps = {
  runCommand?: ValidationCommandRunner | undefined;
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

export function createValidator(deps: ValidatorDeps = {}): Validator {
  const commandRunner = deps.runCommand ?? runCommand;

  async function validateTask(
    task: Task,
    projectDir: string,
    config: Config,
    discovered: DiscoveredValidation | undefined,
    heuristic: DiscoveredValidation | null,
    onStageComplete?: (stages: ValidationStages) => void,
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const stages: ValidationStages = { typecheck: false, lint: false, test: false };

    const runAndRecordStage = async (
      stage: ValidationResult['stage'],
      resolved: ResolvedCommand,
      target?: string,
    ): Promise<'continue' | 'stop'> => {
      const args = target !== undefined ? [...resolved.args, '--', target] : resolved.args;
      const result = await runValidationStep({
        stage,
        cmd: resolved.cmd,
        args,
        source: resolved.source,
        cwd: projectDir,
        runCommand: commandRunner,
      });
      results.push(result);
      if (!result.passed) return 'stop';
      stages[stage] = true;
      onStageComplete?.(stages);
      return 'continue';
    };

    if (config.validation.typecheck) {
      const resolved = resolveCommand('typecheckCommand', config, discovered, heuristic, {
        cmd: 'npx',
        args: ['tsc', '--noEmit'],
        source: 'default',
      });
      if (resolved && (await runAndRecordStage('typecheck', resolved)) === 'stop') return results;
    }

    if (config.validation.lint) {
      const resolved = resolveCommand('lintCommand', config, discovered, heuristic, null);
      if (resolved && (await runAndRecordStage('lint', resolved)) === 'stop') return results;
    }

    if (config.validation.test) {
      const resolved = resolveCommand('testCommand', config, discovered, heuristic, {
        cmd: 'npm',
        args: ['test'],
        source: 'default',
      });
      if (resolved) {
        const useFileTarget = resolved.source === 'default';
        if (useFileTarget) {
          const testPattern = resolveTestPattern(config, discovered, heuristic);
          const testFile = findAffectedTestFile(task.file, projectDir, testPattern);
          if (testFile && (await runAndRecordStage('test', resolved, testFile)) === 'stop') {
            return results;
          }
        } else if ((await runAndRecordStage('test', resolved)) === 'stop') {
          return results;
        }
      }
    }

    return results;
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
      (stages) => {
        publishValidation({ bus: bus, phase: phase }, taskId, {
          phase: 'progress',
          stages,
          startTime,
        });
      },
    );
    publishValidation({ bus: bus, phase: phase }, taskId, { phase: 'result', results, startTime });
    return results;
  }

  return { runValidation };
}

const MAX_VALIDATION_OUTPUT_CHARS = 4096;

function sanitizeValidationOutput(text: string): string {
  return redactSecrets(truncateByChars(text, MAX_VALIDATION_OUTPUT_CHARS));
}

async function runValidationStep(opts: {
  stage: ValidationResult['stage'];
  cmd: string;
  args: string[];
  source: CommandSource;
  cwd: string;
  runCommand: ValidationCommandRunner;
}): Promise<ValidationResult> {
  const { stage, cmd, args, source, cwd, runCommand } = opts;
  try {
    const { stdout } = await runCommand(cmd, args, { cwd });
    return { passed: true, stage, output: sanitizeValidationOutput(stdout) };
  } catch (err: unknown) {
    if (isENOENT(err) || processError.isNotFound(err)) {
      if (source === 'config') {
        return {
          passed: false,
          stage,
          error: `Configured ${stage} command not found: ${cmd}`,
          output: '',
        };
      }
      return { passed: true, stage, output: `${cmd} not found, skipping ${stage}` };
    }
    if (processError.isExitCode(err)) {
      const { output, stderr } = err.data;
      const stdout = String(output ?? '');
      const errText = (String(stderr ?? '') || stdout).trim();
      return {
        passed: false,
        stage,
        output: sanitizeValidationOutput(stdout),
        error: sanitizeValidationOutput(errText),
      };
    }
    throw err;
  }
}

export function formatValidationError(results: ValidationResult[]): string {
  const failed = results.find((r) => !r.passed);
  if (!failed) return '';

  const errorLines = truncateByLines(failed.error || failed.output || '', MAX_ERROR_LINES);

  return [
    'Your previous code had an error. Fix it.',
    `Error type: ${failed.stage}`,
    `Error message: ${errorLines}`,
    'Fix the error and output the complete corrected file.',
  ].join('\n');
}

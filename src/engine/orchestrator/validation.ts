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
import { findAffectedTestFile } from '../../core/validation/test-discovery.js';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';
import { detectValidationHeuristic } from './validation-heuristic.js';

export interface ValidationResult {
  passed: boolean;
  stage: 'typecheck' | 'lint' | 'test';
  error?: string | undefined;
  output?: string | undefined;
}

const MAX_ERROR_LINES = 20;
export type ValidationCommandRunner = typeof runCommand;

export interface Validator {
  findAffectedTestFile: (taskFile: string, projectDir: string, testPattern?: string) => string | null;
  runValidation: (
    task: Task,
    projectDir: string,
    config: Config,
    bus: EventBus,
    phase: Phase,
    taskId: TaskId,
    discoveredValidation?: DiscoveredValidation,
  ) => Promise<ValidationResult[]>;
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
  return config.validation.testPattern ?? discovered?.testPattern ?? heuristic?.testPattern ?? undefined;
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

    if (config.validation.typecheck) {
      const resolved = resolveCommand('typecheckCommand', config, discovered, heuristic, { cmd: 'npx', args: ['tsc', '--noEmit'], source: 'default' });
      if (resolved) {
        const result = await runValidationStep({ stage: 'typecheck', cmd: resolved.cmd, args: resolved.args, cwd: projectDir, runCommand: commandRunner });
        results.push(result);
        if (!result.passed) return results;
        stages.typecheck = true;
        onStageComplete?.(stages);
      }
    }

    if (config.validation.lint) {
      const resolved = resolveCommand('lintCommand', config, discovered, heuristic, null);
      if (resolved) {
        const result = await runValidationStep({ stage: 'lint', cmd: resolved.cmd, args: resolved.args, cwd: projectDir, runCommand: commandRunner });
        results.push(result);
        if (!result.passed) return results;
        stages.lint = true;
        onStageComplete?.(stages);
      }
    }

    if (config.validation.test) {
      const resolved = resolveCommand('testCommand', config, discovered, heuristic, { cmd: 'npm', args: ['test'], source: 'default' });
      if (resolved) {
        const useFileTarget = resolved.source === 'default';
        if (useFileTarget) {
          const testPattern = resolveTestPattern(config, discovered, heuristic);
          const testFile = findAffectedTestFile(task.file, projectDir, testPattern);
          if (testFile) {
            const args = [...resolved.args, '--', testFile];
            const result = await runValidationStep({ stage: 'test', cmd: resolved.cmd, args, cwd: projectDir, runCommand: commandRunner });
            results.push(result);
            if (!result.passed) return results;
            stages.test = true;
            onStageComplete?.(stages);
          }
        } else {
          const result = await runValidationStep({ stage: 'test', cmd: resolved.cmd, args: resolved.args, cwd: projectDir, runCommand: commandRunner });
          results.push(result);
          if (!result.passed) return results;
          stages.test = true;
          onStageComplete?.(stages);
        }
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
    discoveredValidation?: DiscoveredValidation,
  ): Promise<ValidationResult[]> {
    const startTime = Date.now();
    publishValidation(bus, phase, taskId, { phase: 'start' });
    const heuristic = detectValidationHeuristic(projectDir);
    const results = await validateTask(task, projectDir, config, discoveredValidation, heuristic, (stages) => {
      publishValidation(bus, phase, taskId, { phase: 'progress', stages, startTime });
    });
    publishValidation(bus, phase, taskId, { phase: 'result', results, startTime });
    return results;
  }

  return { findAffectedTestFile, runValidation };
}

async function runValidationStep(opts: {
  stage: ValidationResult['stage'];
  cmd: string;
  args: string[];
  cwd: string;
  runCommand: ValidationCommandRunner;
}): Promise<ValidationResult> {
  const { stage, cmd, args, cwd, runCommand } = opts;
  try {
    const { stdout, stderr, code } = await runCommand(cmd, args, { cwd });

    if (code === 127) {
      return { passed: true, stage, output: `${cmd} not found, skipping ${stage}` };
    }

    const result: ValidationResult = { passed: code === 0, stage, output: stdout };
    if (code !== 0) {
      result.error = (stderr || stdout).trim();
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

  const errorLines = truncateByLines(failed.error || failed.output || '', MAX_ERROR_LINES);

  return [
    'Your previous code had an error. Fix it.',
    `Error type: ${failed.stage}`,
    `Error message: ${errorLines}`,
    'Fix the error and output the complete corrected file.',
  ].join('\n');
}

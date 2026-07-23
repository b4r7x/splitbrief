import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import type { ValidationStageCommands, ValidationStages } from '../../events/types.js';
import { runCommand } from '../../../lib/process/spawn/run-command.js';
import { publishValidation, publishWarning } from '../events.js';
import { sanitizeDiscoveredValidation } from '../planning/sanitize-discovered-validation.js';
import { detectValidationHeuristic } from './heuristic.js';
import {
  formatValidationCommand,
  resolveCommand,
  resolveTestTarget,
  typecheckDefaultCommand,
} from './commands.js';
import { runValidationStep, skippedStage } from './stage.js';
import type { ValidationResult } from './result.js';
import type {
  PrimeBaselineOptions,
  RunValidationOptions,
  Validator,
  ValidatorDeps,
} from './types.js';

const DEFAULT_VALIDATION_TIMEOUT_MS = 600_000;

function resolveValidationTimeout(config: Config): number {
  return config.validation.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
}

interface ValidationProgress {
  stages: ValidationStages;
  activeStage?: ValidationStage | undefined;
  commands: ValidationStageCommands;
}

export function createValidator(deps: ValidatorDeps = {}): Validator {
  const commandRunner = deps.runCommand ?? runCommand;
  let baselineFailingStages: ReadonlySet<ValidationStage> | null = null;

  async function probeBaseline(
    task: Task,
    projectDir: string,
    config: Config,
    discovered: ReturnType<typeof sanitizeDiscoveredValidation>,
    heuristic: ReturnType<typeof detectValidationHeuristic>,
    signal: AbortSignal | undefined,
  ): Promise<Set<ValidationStage>> {
    const failing = new Set<ValidationStage>();
    const probeStage = async (
      stage: ValidationStage,
      resolved: ReturnType<typeof resolveCommand>,
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
        signal,
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
    discovered: ReturnType<typeof sanitizeDiscoveredValidation>,
    heuristic: ReturnType<typeof detectValidationHeuristic>,
    signal?: AbortSignal | undefined,
    onProgress?: (progress: ValidationProgress) => void,
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const stages: ValidationStages = { typecheck: false, lint: false, test: false };
    const commands: ValidationStageCommands = {};

    const runAndRecordStage = async (
      stage: ValidationResult['stage'],
      resolved: NonNullable<ReturnType<typeof resolveCommand>>,
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
        signal,
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
    const { task, projectDir, config, discoveredValidation, signal } = opts;
    const heuristic = detectValidationHeuristic(projectDir);
    const sanitizedDiscovered = sanitizeDiscoveredValidation(discoveredValidation);
    baselineFailingStages = await probeBaseline(
      task,
      projectDir,
      config,
      sanitizedDiscovered,
      heuristic,
      signal,
    );
  }

  async function runValidation(opts: RunValidationOptions): Promise<ValidationResult[]> {
    const { task, projectDir, config, bus, phase, discoveredValidation, signal } = opts;
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
      signal,
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
      publishWarning({
        bus: bus,
        phase: phase,
        message: `Task ${taskId} was not validated: every enabled validation stage was skipped (${results
          .map((r) => r.stage)
          .join(', ')}).`,
      });
    }
    return results;
  }

  return {
    primeBaseline,
    runValidation,
    getBaselineFailingStages: () => baselineFailingStages ?? new Set<ValidationStage>(),
  };
}

import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Phase, ValidationStage } from '../../../core/schemas/enums.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import type { EventBus, ValidationStageCommands, ValidationStages } from '../../events/types.js';
import {
  GATE_ORDER,
  NO_GATES_WARNING,
  STAGE_TIMEOUT_MS,
} from '../../../core/pipeline-spec/gates.js';
import {
  readManifestCommands,
  type ManifestCommands,
} from '../../../core/validation/manifest-commands.js';
import { detectFormatFixCommand } from '../../../core/validation/lint-detection.js';
import { buildTestArgs, detectStack } from '../../../core/validation/stacks/registry.js';
import type { Stack } from '../../../core/validation/stacks/types.js';
import {
  resolveStageCommand,
  type ResolvedCommand,
} from '../../../core/validation/stage-command.js';
import { routeTestScript } from '../../../core/validation/test-script-route.js';
import { runCommand } from '../../../lib/process/spawn/run-command.js';
import { labelError } from '../../../utils/format-errors.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { publishFullSuite, publishValidation, publishWarning } from '../events.js';
import { acceptValidationResults, evidenceNamesChangedFile } from './acceptance.js';
import { withRunBaseTree, type RunBase } from '../isolation/base-tree.js';
import { failingFilesOf } from '../task/file-owner.js';
import { stageFailureKeys } from './extract-failure-keys.js';
import { sanitizeDiscoveredValidation } from '../planning/sanitize-discovered-validation.js';
import { fingerprintFiles } from '../changed-files-baseline.js';
import { formatValidationCommand, resolveTestTarget, type TestTargetMode } from './commands.js';
import { runValidationStep, skippedStage } from './stage.js';
import type { ValidationResult } from './result.js';
import type {
  RunFullSuiteOptions,
  RunFullSuiteResult,
  RunValidationOptions,
  ValidationCommandRunner,
  Validator,
  ValidatorDeps,
} from './types.js';

const DEFAULT_VALIDATION_TIMEOUT_MS = STAGE_TIMEOUT_MS;

const FULL_SUITE_TASK: Pick<Task, 'suggestedFiles'> = { suggestedFiles: [''] };

function resolveValidationTimeout(config: Config): number {
  return config.validation.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
}

type StageContext = {
  projectDir: string;
  config: Config;
  manifest: ManifestCommands;
  discovered: DiscoveredValidation | undefined;
  stack: Stack | null;
};

type StagePlan =
  | { kind: 'run'; resolved: ResolvedCommand; args: string[]; command: string }
  | { kind: 'skip'; reason: string };

export function buildStageContext(input: {
  projectDir: string;
  config: Config;
  discoveredValidation: DiscoveredValidation | undefined;
  notices: Pick<RunValidationOptions, 'bus' | 'phase'>;
}): StageContext {
  const { projectDir, config, discoveredValidation, notices } = input;
  const manifest = readManifestCommands(projectDir);
  const stack = detectStack(projectDir, config.validation.stack);
  return {
    projectDir,
    config,
    manifest,
    discovered: sanitizeDiscoveredValidation(discoveredValidation, notices, {
      projectDir,
      config,
      manifest,
      stack,
    }),
    stack,
  };
}

function unresolvedStackReason(stage: ValidationStage): string {
  return `no ${stage} command for an unrecognised stack`;
}

const FORMATTABLE_FILE = /\.(c|m)?[jt]sx?$|\.(json|jsonc|css)$/;

type FormatWarning = {
  message: string;
  safety: { category: 'validation'; code: 'validation_formatted' | 'validation_format_failed' };
};

// Layout the implementer left unformatted fails lint and costs an attempt, so the
// project's own formatter runs first. Only the brief's own changed files are
// rewritten: nothing outside its scope mutates and change attribution holds.
async function formatFiles(opts: {
  ctx: StageContext;
  changedFiles: readonly string[];
  runCommand: ValidationCommandRunner;
  signal: AbortSignal | undefined;
}): Promise<FormatWarning | undefined> {
  const command = detectFormatFixCommand(opts.ctx.projectDir);
  if (command === null) return undefined;
  const formattable = opts.changedFiles.filter((file) => FORMATTABLE_FILE.test(file));
  const before = await fingerprintFiles(opts.ctx.projectDir, formattable);
  // A file the brief deleted is not handed over: the formatter fails the whole pass on a missing path.
  const files = formattable.filter((file) => before.get(file) !== 'missing');
  if (files.length === 0) return undefined;
  const parts = parseShellCommand(command);
  const cmd = parts[0];
  if (cmd === undefined) return undefined;
  try {
    await opts.runCommand(cmd, [...parts.slice(1), ...files], {
      cwd: opts.ctx.projectDir,
      timeout: resolveValidationTimeout(opts.ctx.config),
      label: 'format',
      signal: opts.signal,
    });
  } catch (err) {
    return {
      message: labelError(
        `Formatting the changed files with ${command} failed; the review gates still run`,
        err,
      ),
      safety: { category: 'validation', code: 'validation_format_failed' },
    };
  }
  const after = await fingerprintFiles(opts.ctx.projectDir, files);
  const rewritten = files.filter((file) => before.get(file) !== after.get(file));
  if (rewritten.length === 0) return undefined;
  return {
    message: `Formatted ${rewritten.length} file(s) with ${command}: ${rewritten.join(', ')}`,
    safety: { category: 'validation', code: 'validation_formatted' },
  };
}

export function planStage(
  stage: ValidationStage,
  task: { suggestedFiles: readonly string[] },
  ctx: StageContext,
  changedFiles: readonly string[],
  mode: TestTargetMode = 'related',
): StagePlan {
  const resolved = resolveStageCommand({ stage, ...ctx });
  if (resolved === null) return { kind: 'skip', reason: unresolvedStackReason(stage) };
  if (stage !== 'test') {
    return {
      kind: 'run',
      resolved,
      args: resolved.args,
      command: formatValidationCommand(resolved.cmd, resolved.args),
    };
  }
  const target = resolveTestTarget({
    resolved,
    task,
    changedFiles,
    projectDir: ctx.projectDir,
    config: ctx.config,
    discovered: ctx.discovered,
    stack: ctx.stack,
    mode,
  });
  if (!target.run) return { kind: 'skip', reason: target.skipReason };
  const routed =
    routeTestScript({ projectDir: ctx.projectDir, resolved, targets: target.targets }) ?? resolved;
  const args = buildTestArgs(routed, target.targets, ctx.stack?.narrowing ?? { kind: 'none' });
  return {
    kind: 'run',
    resolved: routed,
    args,
    command: formatValidationCommand(routed.cmd, args),
  };
}

async function markPreExisting(input: {
  red: readonly ValidationResult[];
  ctx: StageContext;
  base: RunBase;
  workspaceDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  signal: AbortSignal | undefined;
  runCommand: ValidationCommandRunner;
}): Promise<ValidationResult[]> {
  const eligible = input.red.filter(
    (result) => result.stage !== 'test' || (result.failingTests?.length ?? 0) > 0,
  );
  if (eligible.length === 0) return [...input.red];
  return withRunBaseTree(input.base, async (dir) => {
    const at = { ...input.ctx, projectDir: dir };
    const results: ValidationResult[] = [];
    for (const result of input.red) {
      if (result.stage === 'test' && (result.failingTests?.length ?? 0) === 0) {
        results.push(result);
        continue;
      }
      const files = result.stage === 'test' ? failingFilesOf(result, input.workspaceDir) : [];
      const plan =
        files.length === 0
          ? planStage(result.stage, FULL_SUITE_TASK, at, [], 'full')
          : planStage('test', { suggestedFiles: [] }, at, files, 'check');
      if (plan.kind === 'skip') {
        results.push(result);
        continue;
      }
      const notices = { bus: input.bus, phase: input.phase };
      const startedAt = Date.now();
      publishFullSuite(notices, {
        status: 'running',
        stage: result.stage,
        command: plan.command,
        moment: 'base',
      });
      const checked = await runValidationStep({
        stage: result.stage,
        cmd: plan.resolved.cmd,
        args: plan.args,
        source: plan.resolved.source,
        cwd: dir,
        timeout: resolveValidationTimeout(input.config),
        runCommand: input.runCommand,
        command: plan.command,
        stack: input.ctx.stack,
        signal: input.signal,
      });
      publishFullSuite(notices, {
        status: 'done',
        stage: result.stage,
        command: plan.command,
        moment: 'base',
        passed: checked.passed,
        duration: Date.now() - startedAt,
      });
      const keys = stageFailureKeys(result);
      let preExisting: string[] = [];
      if (!checked.passed && checked.skipped !== true) {
        if (result.timedOut === true) {
          if (checked.timedOut === true) preExisting = keys;
        } else if (checked.timedOut !== true) {
          const known = new Set(
            stageFailureKeys(checked).map((key) =>
              result.stage === 'test' ? key : key.replaceAll(`${dir}/`, ''),
            ),
          );
          preExisting = keys.filter((key) =>
            known.has(result.stage === 'test' ? key : key.replaceAll(`${input.workspaceDir}/`, '')),
          );
        }
      }
      results.push(preExisting.length === 0 ? result : { ...result, preExisting });
    }
    return results;
  });
}

export function createValidator(deps: ValidatorDeps = {}): Validator {
  const commandRunner = deps.runCommand ?? runCommand;
  async function runFullSuite(opts: RunFullSuiteOptions): Promise<RunFullSuiteResult> {
    const { projectDir, config, bus, phase, discoveredValidation, signal, base } = opts;
    const ctx = buildStageContext({
      projectDir,
      config,
      discoveredValidation,
      notices: { bus, phase },
    });
    const results: ValidationResult[] = [];
    const newFailures: Partial<Record<ValidationStage, string[]>> = {};
    for (const stage of GATE_ORDER) {
      if (!config.validation[stage]) continue;
      const plan = planStage(stage, FULL_SUITE_TASK, ctx, [], 'full');
      if (plan.kind === 'skip') {
        results.push(skippedStage(stage, plan.reason));
        continue;
      }
      const startedAt = Date.now();
      publishFullSuite(
        { bus, phase },
        {
          status: 'running',
          stage,
          command: plan.command,
          moment: 'pre-review',
        },
      );
      const result = await runValidationStep({
        stage,
        cmd: plan.resolved.cmd,
        args: plan.args,
        source: plan.resolved.source,
        cwd: ctx.projectDir,
        timeout: resolveValidationTimeout(config),
        runCommand: commandRunner,
        command: plan.command,
        stack: ctx.stack,
        signal,
      });
      const durationMs = Date.now() - startedAt;
      publishFullSuite(
        { bus, phase },
        {
          status: 'done',
          stage,
          command: plan.command,
          moment: 'pre-review',
          passed: result.passed,
          duration: durationMs,
        },
      );
      let checked = result;
      if (!result.passed && result.skipped !== true && base !== undefined) {
        [checked = result] = await markPreExisting({
          red: [result],
          ctx,
          base,
          workspaceDir: projectDir,
          config,
          bus,
          phase,
          signal,
          runCommand: commandRunner,
        });
      }
      results.push(checked);
      if (checked.passed || checked.skipped === true) continue;
      const fresh = stageFailureKeys(checked).filter((key) => !checked.preExisting?.includes(key));
      if (fresh.length > 0) {
        newFailures[stage] = fresh;
        for (const next of GATE_ORDER.slice(GATE_ORDER.indexOf(stage) + 1)) {
          if (!config.validation[next]) continue;
          const plan = planStage(next, FULL_SUITE_TASK, ctx, [], 'full');
          const command = plan.kind === 'run' ? plan.command : next;
          results.push({
            ...skippedStage(next, `${stage} failed`),
            command,
            output: `not run: ${stage} failed`,
          });
          publishFullSuite(
            { bus, phase },
            {
              status: 'not-run',
              stage: next,
              command,
              moment: 'pre-review',
            },
          );
        }
        break;
      }
    }
    return { results, newFailures };
  }

  async function runValidation(opts: RunValidationOptions): Promise<ValidationResult[]> {
    const { task, projectDir, config, bus, phase, discoveredValidation, signal } = opts;
    const taskId = task.id;
    const startTime = Date.now();
    publishValidation({ bus: bus, phase: phase }, taskId, { phase: 'start' });
    const ctx = buildStageContext({
      projectDir,
      config,
      discoveredValidation,
      notices: { bus, phase },
    });
    const results: ValidationResult[] = [];
    const skipReasons: Partial<Record<ValidationStage, string>> = {};
    const stages: ValidationStages = { typecheck: false, lint: false, test: false };
    const commands: ValidationStageCommands = {};
    const accept = () => acceptValidationResults(results, opts.changedFiles);
    for (const stage of GATE_ORDER) {
      if (!opts.stages.includes(stage) || !config.validation[stage]) continue;
      const plan = planStage(stage, task, ctx, opts.changedFiles, opts.testMode);
      if (plan.kind === 'skip') {
        skipReasons[stage] = plan.reason;
        results.push(skippedStage(stage, plan.reason));
        continue;
      }
      commands[stage] = plan.command;
      publishValidation({ bus, phase }, taskId, {
        phase: 'progress',
        stages: { ...stages },
        activeStage: stage,
        startTime,
        commands: { ...commands },
      });
      let result = await runValidationStep({
        stage,
        cmd: plan.resolved.cmd,
        args: plan.args,
        source: plan.resolved.source,
        cwd: projectDir,
        timeout: resolveValidationTimeout(config),
        runCommand: commandRunner,
        command: plan.command,
        stack: ctx.stack,
        signal,
        changedFiles: opts.changedFiles,
      });
      if (
        !result.passed &&
        result.skipped !== true &&
        opts.base !== undefined &&
        !evidenceNamesChangedFile(result, opts.changedFiles)
      ) {
        [result = result] = await markPreExisting({
          red: [result],
          ctx,
          base: opts.base,
          workspaceDir: projectDir,
          config,
          bus,
          phase,
          signal,
          runCommand: commandRunner,
        });
      }
      results.push(result);
      if (!accept().accepted) break;
      if (result.passed && result.skipped !== true) stages[stage] = true;
      publishValidation({ bus, phase }, taskId, {
        phase: 'progress',
        stages: { ...stages },
        startTime,
        commands: { ...commands },
      });
    }
    const acceptance = accept();
    publishValidation({ bus: bus, phase: phase }, taskId, {
      phase: 'result',
      results,
      startTime,
      acceptance,
    });
    if (results.length > 0 && results.every((r) => r.skipped)) {
      const skippedStages = results.map((r) => r.stage);
      const unknownStack = skippedStages.every(
        (stage) => skipReasons[stage] === unresolvedStackReason(stage),
      );
      publishWarning(
        unknownStack
          ? {
              bus: bus,
              phase: phase,
              message: `Task ${taskId} was not validated: no gates for an unrecognised stack (${skippedStages.join(', ')}).`,
              safety: NO_GATES_WARNING,
            }
          : {
              bus: bus,
              phase: phase,
              message: `Task ${taskId} was not validated: every enabled validation stage was skipped (${skippedStages.join(', ')}): ${Object.values(skipReasons).join('; ')}.`,
            },
      );
    }
    return results;
  }

  async function formatChangedFiles(
    opts: Omit<RunValidationOptions, 'stages' | 'base'>,
  ): Promise<void> {
    if (!opts.config.validation.lint || opts.changedFiles.length === 0) return;
    const ctx = buildStageContext({
      ...opts,
      discoveredValidation: opts.discoveredValidation,
      notices: { bus: opts.bus, phase: opts.phase },
    });
    const warning = await formatFiles({
      ctx,
      changedFiles: opts.changedFiles,
      runCommand: commandRunner,
      signal: opts.signal,
    });
    if (warning !== undefined)
      publishWarning({ bus: opts.bus, phase: opts.phase, taskId: opts.task.id, ...warning });
  }

  return { runFullSuite, runValidation, formatChangedFiles };
}

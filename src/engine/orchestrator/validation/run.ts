import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import type {
  DiscoveredValidation,
  FullSuiteStageRuns,
  PersistedValidationBaseline,
} from '../../../core/schemas/workflow.js';
import type { ValidationStageCommands, ValidationStages } from '../../events/types.js';
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
import {
  publishFullSuite,
  publishValidation,
  publishValidationBaseline,
  publishWarning,
} from '../events.js';
import { decideValidationAcceptance, type ValidationAcceptance } from './acceptance.js';
import { stageFailureKeys } from './extract-failure-keys.js';
import { sanitizeDiscoveredValidation } from '../planning/sanitize-discovered-validation.js';
import { fingerprintFiles } from '../changed-files-baseline.js';
import { formatValidationCommand, resolveTestTarget, type TestTargetMode } from './commands.js';
import { runValidationStep, skippedStage } from './stage.js';
import type { ValidationResult } from './result.js';
import type {
  PrimeBaselineOptions,
  RunFullSuiteOptions,
  RunFullSuiteResult,
  RunValidationOptions,
  ValidationBaseline,
  ValidationCommandRunner,
  Validator,
  ValidatorDeps,
} from './types.js';

const DEFAULT_VALIDATION_TIMEOUT_MS = STAGE_TIMEOUT_MS;

const FULL_SUITE_TASK: Pick<Task, 'suggestedFiles'> = { suggestedFiles: [''] };

function resolveValidationTimeout(config: Config): number {
  return config.validation.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
}

interface ValidationProgress {
  stages: ValidationStages;
  activeStage?: ValidationStage | undefined;
  commands: ValidationStageCommands;
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

function toPersistedBaseline(baseline: ValidationBaseline): PersistedValidationBaseline {
  const commands: PersistedValidationBaseline['commands'] = {};
  const failures: PersistedValidationBaseline['failures'] = {};
  for (const stage of GATE_ORDER) {
    const command = baseline.commands[stage];
    if (command !== undefined) commands[stage] = command;
    const keys = baseline.failures[stage];
    if (keys !== undefined) failures[stage] = [...keys];
  }
  return { failingStages: [...baseline.failingStages], commands, failures };
}

function fromPersistedBaseline(persisted: PersistedValidationBaseline): ValidationBaseline {
  const failures: ValidationBaseline['failures'] = {};
  for (const stage of GATE_ORDER) {
    const keys = persisted.failures[stage];
    if (keys !== undefined) failures[stage] = new Set(keys);
  }
  return {
    failingStages: new Set(persisted.failingStages),
    commands: persisted.commands,
    failures,
  };
}

const FORMATTABLE_FILE = /\.(c|m)?[jt]sx?$|\.(json|jsonc|css)$/;

type FormatWarning = {
  message: string;
  safety: { category: 'validation'; code: 'validation_formatted' | 'validation_format_failed' };
};

// Layout the implementer left unformatted fails lint and costs an attempt, so the
// project's own formatter runs first. Only the brief's own changed files are
// rewritten: nothing outside its scope mutates and change attribution holds.
async function formatChangedFiles(opts: {
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
        `Formatting the changed files with ${command} failed; the lint stage ran anyway`,
        err,
      ),
      safety: { category: 'validation', code: 'validation_format_failed' },
    };
  }
  const after = await fingerprintFiles(opts.ctx.projectDir, files);
  const rewritten = files.filter((file) => before.get(file) !== after.get(file));
  if (rewritten.length === 0) return undefined;
  return {
    message: `Formatted ${rewritten.length} file(s) with ${command} before the lint stage: ${rewritten.join(', ')}`,
    safety: { category: 'validation', code: 'validation_formatted' },
  };
}

export function planStage(
  stage: ValidationStage,
  task: Pick<Task, 'suggestedFiles'>,
  ctx: StageContext,
  changedFiles: readonly string[],
  mode: TestTargetMode = 'narrow',
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

export function createValidator(deps: ValidatorDeps = {}): Validator {
  const commandRunner = deps.runCommand ?? runCommand;
  let baseline: ValidationBaseline | null = null;

  async function probeBaseline(
    task: Task,
    ctx: StageContext,
    signal: AbortSignal | undefined,
    onProgress?: (progress: ValidationProgress) => void,
  ): Promise<{ baseline: ValidationBaseline; results: ValidationResult[] }> {
    const failingStages = new Set<ValidationStage>();
    const failures: Partial<Record<ValidationStage, ReadonlySet<string>>> = {};
    const results: ValidationResult[] = [];
    const stages: ValidationStages = { typecheck: false, lint: false, test: false };
    const commands: ValidationStageCommands = {};

    for (const stage of GATE_ORDER) {
      if (!ctx.config.validation[stage]) continue;
      const plan = planStage(stage, task, ctx, []);
      if (plan.kind === 'skip') continue;
      commands[stage] = plan.command;
      onProgress?.({ stages: { ...stages }, activeStage: stage, commands: { ...commands } });
      const result = await runValidationStep({
        stage,
        cmd: plan.resolved.cmd,
        args: plan.args,
        source: plan.resolved.source,
        cwd: ctx.projectDir,
        timeout: resolveValidationTimeout(ctx.config),
        runCommand: commandRunner,
        command: plan.command,
        stack: ctx.stack,
        signal,
      });
      results.push(result);
      if (!result.passed) {
        if (result.timedOut !== true) {
          failingStages.add(stage);
          failures[stage] = new Set(stageFailureKeys(result));
        }
      } else if (result.skipped !== true) {
        stages[stage] = true;
      }
      onProgress?.({ stages: { ...stages }, commands: { ...commands } });
    }
    return { baseline: { failingStages, commands, failures }, results };
  }

  async function runFullSuite(opts: RunFullSuiteOptions): Promise<RunFullSuiteResult> {
    const {
      projectDir,
      config,
      bus,
      phase,
      moment,
      discoveredValidation,
      signal,
      baseline,
      baselineStages,
    } = opts;
    const ctx = buildStageContext({
      projectDir,
      config,
      discoveredValidation,
      notices: { bus, phase },
    });
    const results: ValidationResult[] = [];
    const failures: Partial<Record<ValidationStage, string[]>> = {};
    const newFailures: Partial<Record<ValidationStage, string[]>> = {};
    const stages: FullSuiteStageRuns = {};
    const configuredTimeout = resolveValidationTimeout(config);
    for (const stage of GATE_ORDER) {
      if (!config.validation[stage]) continue;
      const baselineStage = baselineStages?.[stage];
      if (baselineStage?.kind === 'timed-out') {
        results.push(
          skippedStage(
            stage,
            `timed out after ${Math.round(baselineStage.timeoutMs / 1000)}s at the run-start baseline`,
          ),
        );
        continue;
      }
      const plan = planStage(stage, FULL_SUITE_TASK, ctx, [], 'full');
      if (plan.kind === 'skip') {
        results.push(skippedStage(stage, plan.reason));
        continue;
      }
      const timeout =
        baselineStage?.kind === 'completed'
          ? Math.max(configuredTimeout, 3 * baselineStage.durationMs)
          : configuredTimeout;
      const startedAt = Date.now();
      publishFullSuite({ bus, phase }, { status: 'running', stage, command: plan.command, moment });
      const result = await runValidationStep({
        stage,
        cmd: plan.resolved.cmd,
        args: plan.args,
        source: plan.resolved.source,
        cwd: ctx.projectDir,
        timeout,
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
          moment,
          passed: result.passed,
          duration: durationMs,
        },
      );
      results.push(result);
      if (result.skipped !== true) {
        stages[stage] =
          result.timedOut === true
            ? { kind: 'timed-out', durationMs, timeoutMs: timeout }
            : { kind: 'completed', durationMs };
      }
      if (result.passed) continue;
      const keys = stageFailureKeys(result);
      if (result.timedOut === true) {
        if (baseline !== undefined) newFailures[stage] = keys;
        continue;
      }
      failures[stage] = keys;
      const known = baseline?.[stage];
      const fresh = known === undefined ? keys : keys.filter((key) => !known.includes(key));
      if (fresh.length > 0) newFailures[stage] = fresh;
    }
    return { results, failures, newFailures, stages };
  }

  async function validateTask(
    task: Task,
    ctx: StageContext,
    changedFiles: readonly string[] | undefined,
    signal?: AbortSignal | undefined,
    onProgress?: (progress: ValidationProgress) => void,
  ): Promise<{
    results: ValidationResult[];
    skipReasons: Partial<Record<ValidationStage, string>>;
    formatWarning?: FormatWarning;
  }> {
    const results: ValidationResult[] = [];
    const skipReasons: Partial<Record<ValidationStage, string>> = {};
    const stages: ValidationStages = { typecheck: false, lint: false, test: false };
    const commands: ValidationStageCommands = {};
    let formatWarning: FormatWarning | undefined;

    for (const stage of GATE_ORDER) {
      if (!ctx.config.validation[stage]) continue;
      const plan = planStage(stage, task, ctx, changedFiles ?? []);
      if (plan.kind === 'skip') {
        skipReasons[stage] = plan.reason;
        results.push(skippedStage(stage, plan.reason));
        continue;
      }
      commands[stage] = plan.command;
      onProgress?.({ stages: { ...stages }, activeStage: stage, commands: { ...commands } });
      if (stage === 'lint' && changedFiles !== undefined && changedFiles.length > 0) {
        formatWarning = await formatChangedFiles({
          ctx,
          changedFiles,
          runCommand: commandRunner,
          signal,
        });
      }
      const result = await runValidationStep({
        stage,
        cmd: plan.resolved.cmd,
        args: plan.args,
        source: plan.resolved.source,
        cwd: ctx.projectDir,
        timeout: resolveValidationTimeout(ctx.config),
        runCommand: commandRunner,
        command: plan.command,
        stack: ctx.stack,
        signal,
        changedFiles,
      });
      results.push(result);
      if (!result.passed) {
        if (!baseline?.failingStages.has(stage)) {
          return { results, skipReasons, ...(formatWarning !== undefined && { formatWarning }) };
        }
        onProgress?.({ stages: { ...stages }, commands: { ...commands } });
        continue;
      }
      // A step that skipped itself — the binary is missing, the subcommand is unavailable —
      // returns `passed`, and a tick for a gate that never ran reads as "everything green".
      if (result.skipped !== true) stages[stage] = true;
      onProgress?.({ stages: { ...stages }, commands: { ...commands } });
    }

    return { results, skipReasons, ...(formatWarning !== undefined && { formatWarning }) };
  }

  async function primeBaseline(
    opts: PrimeBaselineOptions,
  ): Promise<PersistedValidationBaseline | undefined> {
    if (deps.captureBaseline !== true) return undefined;
    if (baseline !== null) return toPersistedBaseline(baseline);
    if (opts.persistedBaseline !== undefined) {
      baseline = fromPersistedBaseline(opts.persistedBaseline);
      return opts.persistedBaseline;
    }
    const { task, projectDir, config, bus, phase, discoveredValidation, signal } = opts;
    const startTime = Date.now();
    publishValidationBaseline({ bus: bus, phase: phase }, { phase: 'start' });
    const ctx = buildStageContext({
      projectDir,
      config,
      discoveredValidation,
      notices: { bus, phase },
    });
    const probe = await probeBaseline(task, ctx, signal, (progress) => {
      publishValidationBaseline(
        { bus: bus, phase: phase },
        {
          phase: 'progress',
          stages: progress.stages,
          startTime,
          ...(progress.activeStage !== undefined && { activeStage: progress.activeStage }),
          commands: progress.commands,
        },
      );
    });
    baseline = probe.baseline;
    publishValidationBaseline(
      { bus: bus, phase: phase },
      {
        phase: 'result',
        results: probe.results,
        startTime,
      },
    );
    return toPersistedBaseline(baseline);
  }

  function decideAcceptance(opts: {
    results: readonly ValidationResult[];
    changedFiles: readonly string[];
  }): ValidationAcceptance {
    return decideValidationAcceptance({
      results: opts.results,
      baselineFailingStages: baseline?.failingStages ?? new Set<ValidationStage>(),
      baselineCommands: baseline?.commands,
      baselineFailureKeys: baseline?.failures,
      changedFiles: opts.changedFiles,
    });
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
    const { results, skipReasons, formatWarning } = await validateTask(
      task,
      ctx,
      opts.changedFiles,
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
    if (formatWarning !== undefined) {
      publishWarning({
        bus: bus,
        phase: phase,
        taskId,
        message: formatWarning.message,
        safety: formatWarning.safety,
      });
    }
    const acceptance = decideAcceptance({ results, changedFiles: opts.changedFiles ?? [] });
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
              message: `Task ${taskId} was not validated: every enabled validation stage was skipped (${skippedStages.join(', ')}).`,
            },
      );
    }
    return results;
  }

  return { primeBaseline, runFullSuite, runValidation, decideAcceptance };
}

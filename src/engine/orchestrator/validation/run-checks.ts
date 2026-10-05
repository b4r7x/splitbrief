import { STAGE_TIMEOUT_MS } from '../../../core/pipeline-spec/gates.js';
import { readPackageJson } from '../../../core/project-meta.js';
import type { PackageScriptsReadinessInput } from '../../../core/readiness/checks/validation.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { isENOENT, processError } from '../../../lib/process/errors.js';
import { runCommand } from '../../../lib/process/spawn/run-command.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars } from '../../../utils/truncate.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { EventBus } from '../../events/types.js';
import { checkCommandRefusal } from '../planning/sanitize-discovered-validation.js';
import type { ValidationResult } from './result.js';
import { buildStageContext, planStage } from './run.js';
import { MAX_VALIDATION_OUTPUT_CHARS, runValidationStep } from './stage.js';
import type { ValidationCommandRunner } from './types.js';

export type CheckRunStatus = 'pass' | 'fail' | 'not-runnable' | 'refused' | 'unknown';

export type CheckRunResult = {
  checkId: string;
  status: CheckRunStatus;
  output: string;
};

export type RunChecksOptions = {
  task?: Task | undefined;
  tasks?: readonly Task[] | undefined;
  plan?: Plan | undefined;
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  planApproved: boolean;
  discoveredValidation?: DiscoveredValidation | undefined;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
};

export function checkRegistry(
  opts: Pick<RunChecksOptions, 'task' | 'tasks' | 'plan'>,
): Map<string, Check> {
  return new Map(
    [
      ...(opts.plan?.checks ?? []),
      ...(opts.tasks ?? []).flatMap((task) => task.checks ?? []),
      ...(opts.task?.checks ?? []),
    ].map((check) => [check.id, check]),
  );
}

function boundedOutput(text: string): string {
  return redactSecrets(truncateByChars(text, MAX_VALIDATION_OUTPUT_CHARS));
}

function checkStatus(result: ValidationResult): CheckRunStatus {
  if (!result.passed) return 'fail';
  return result.skipped === true ? 'not-runnable' : 'pass';
}

function checkOutput(result: ValidationResult): string {
  if (result.skipped === true) return result.skippedReason ?? result.output ?? '';
  return result.passed ? (result.output ?? '') : (result.error ?? result.output ?? '');
}

function readPackageScripts(projectDir: string): PackageScriptsReadinessInput {
  const pkg = readPackageJson(projectDir);
  if (pkg === null) return { packageJsonExists: false, scripts: {} };
  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) return { packageJsonExists: true, scripts: {} };
  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return { packageJsonExists: true, scripts: Object.fromEntries(entries) };
}

function validationTimeout(config: Config): number {
  return config.validation.timeoutMs ?? STAGE_TIMEOUT_MS;
}

async function runTestCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
  stageContext: ReturnType<typeof buildStageContext>,
): Promise<CheckRunResult> {
  const checkTask: Pick<Task, 'file' | 'files'> = {
    ...opts.task,
    file: check.value,
    files: [check.value],
  };
  const planned = planStage('test', checkTask, stageContext, [check.value]);
  if (planned.kind === 'skip') {
    return { checkId: check.id, status: 'not-runnable', output: planned.reason };
  }
  const result = await runValidationStep({
    stage: 'test',
    cmd: planned.resolved.cmd,
    args: planned.args,
    source: planned.resolved.source,
    cwd: opts.projectDir,
    timeout: validationTimeout(opts.config),
    runCommand: run,
    command: planned.command,
    stack: stageContext.stack,
    signal: opts.signal,
  });
  return { checkId: check.id, status: checkStatus(result), output: checkOutput(result) };
}

async function runCommandCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
  packageScripts: PackageScriptsReadinessInput,
): Promise<CheckRunResult> {
  const refusal = checkCommandRefusal(check.value, {
    planApproved: opts.planApproved,
    packageScripts,
  });
  if (refusal !== null) return { checkId: check.id, status: 'refused', output: refusal };
  const [cmd, ...args] = parseShellCommand(check.value);
  if (cmd === undefined) {
    return { checkId: check.id, status: 'refused', output: 'names no program' };
  }
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd: opts.projectDir,
      timeout: validationTimeout(opts.config),
      label: `check ${check.id}`,
      signal: opts.signal,
    });
    const output = [stdout, stderr].filter((part) => part.trim().length > 0).join('\n');
    return { checkId: check.id, status: 'pass', output: boundedOutput(output) };
  } catch (err: unknown) {
    if (processError.isExitCode(err)) {
      const output = [err.data.output, err.data.stderr]
        .filter((part) => part.trim().length > 0)
        .join('\n');
      return { checkId: check.id, status: 'fail', output: boundedOutput(output) };
    }
    if (processError.isTimeout(err)) {
      return { checkId: check.id, status: 'fail', output: boundedOutput(err.message) };
    }
    if (isENOENT(err) || processError.isNotFound(err)) {
      return { checkId: check.id, status: 'fail', output: `${cmd} not found` };
    }
    throw err;
  }
}

export async function runChecks(
  checkIds: readonly string[],
  opts: RunChecksOptions,
): Promise<CheckRunResult[]> {
  const run = opts.runCommand ?? runCommand;
  const stageContext = buildStageContext({
    projectDir: opts.projectDir,
    config: opts.config,
    discoveredValidation: opts.discoveredValidation,
    notices: { bus: opts.bus, phase: opts.phase },
  });
  const packageScripts = readPackageScripts(opts.projectDir);
  const registry = checkRegistry(opts);
  const results: CheckRunResult[] = [];
  const seen = new Set<string>();
  for (const checkId of checkIds) {
    if (seen.has(checkId)) continue;
    seen.add(checkId);
    const check = registry.get(checkId);
    if (check === undefined) {
      results.push({ checkId, status: 'unknown', output: `no check ${checkId}` });
    } else if (check.kind === 'render') {
      results.push({ checkId, status: 'not-runnable', output: 'render checks are not runnable' });
    } else if (check.kind === 'cmd') {
      results.push(await runCommandCheck(check, opts, run, packageScripts));
    } else {
      results.push(await runTestCheck(check, opts, run, stageContext));
    }
  }
  return results;
}

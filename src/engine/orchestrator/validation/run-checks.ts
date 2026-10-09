import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveApproveLevel, resolveEndChecks } from '../../../core/config/runtime/resolve.js';
import { rendersDir } from '../../../core/paths.js';
import { STAGE_TIMEOUT_MS } from '../../../core/pipeline-spec/gates.js';
import { readPackageJson } from '../../../core/project-meta.js';
import type { PackageScriptsReadinessInput } from '../../../core/readiness/checks/validation.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type {
  DiscoveredValidation,
  ReviewChecksRecord,
  WorkflowState,
} from '../../../core/schemas/workflow.js';
import { isENOENT, processError } from '../../../lib/process/errors.js';
import { runCommand } from '../../../lib/process/spawn/run-command.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { EventBus } from '../../events/types.js';
import type { RunBase } from '../isolation/base-tree.js';
import { checkCommandRefusal } from '../planning/sanitize-discovered-validation.js';
import { changedDefinitionRefusal } from './changed-script.js';
import type { ValidationResult } from './result.js';
import { reviewerCommandRefusal } from './reviewer-command-policy.js';
import { buildStageContext, planTestCheck } from './run.js';
import { boundedOutputTail, runValidationStep } from './stage.js';
import type { ValidationCommandRunner } from './types.js';

export type CheckRunStatus = 'pass' | 'fail' | 'not-runnable' | 'refused' | 'unknown';

export type CheckRunArtifact = {
  path: string;
  sha256: string;
};

export type CheckRunResult = {
  checkId: string;
  status: CheckRunStatus;
  output: string;
  command?: string | undefined;
  exitCode?: number | undefined;
  timedOut?: true | undefined;
  artifacts?: CheckRunArtifact[] | undefined;
  /** The failure keys the same command also showed at the run base. */
  preExisting?: readonly string[] | undefined;
};

export type RunChecksOptions = {
  task?: Task | undefined;
  tasks?: readonly Task[] | undefined;
  plan?: Plan | undefined;
  /** The reviewer checks as required `cmd` checks: a red one splits at the run base; a script the run changed refuses it. */
  reviewChecks?: readonly Check[] | undefined;
  /** The run base: a reviewer check whose script this run changed is refused against it. */
  base?: RunBase | undefined;
  projectDir: string;
  sessionId?: string | undefined;
  checkoutDir?: string | undefined;
  config: Config;
  bus: EventBus;
  phase: Phase;
  npmScriptsApproved: boolean;
  discoveredValidation?: DiscoveredValidation | undefined;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
};

export function planApprovesNpmScripts(opts: {
  config: Config;
  state: Pick<WorkflowState, 'approve'>;
}): boolean {
  return resolveApproveLevel(opts.config) === 'plan' && opts.state.approve === 'plan';
}

/** The reviewer's chosen commands as required `cmd` checks. */
export function reviewCheckList(record: ReviewChecksRecord | undefined): Check[] {
  return (record?.plan.commands ?? []).map((command) => ({
    id: command.id,
    kind: 'cmd',
    value: command.command,
    required: true,
  }));
}

/** The reviewer checks a run may name: none while End-of-run checks are off or the plan was skipped. */
export function enabledReviewChecks(
  config: Config,
  record: ReviewChecksRecord | undefined,
): Check[] {
  return resolveEndChecks(config) && record?.skipped === undefined ? reviewCheckList(record) : [];
}

export function checkRegistry(
  opts: Pick<RunChecksOptions, 'task' | 'tasks' | 'plan' | 'reviewChecks'>,
): Map<string, Check> {
  return new Map(
    [
      ...(opts.plan?.checks ?? []),
      ...(opts.tasks ?? []).flatMap((task) => task.checks ?? []),
      ...(opts.task?.checks ?? []),
      ...(opts.reviewChecks ?? []),
    ].map((check) => [check.id, check]),
  );
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
  const planned = planTestCheck(check.value, stageContext);
  if (planned.kind === 'skip') {
    return { checkId: check.id, status: 'not-runnable', output: planned.reason };
  }
  const result = await runValidationStep({
    cmd: planned.resolved.cmd,
    args: planned.args,
    source: planned.resolved.source,
    cwd: opts.projectDir,
    timeout: validationTimeout(opts.config),
    runCommand: run,
    command: planned.command,
    signal: opts.signal,
  });
  if (result.missingExecutable !== undefined) {
    return {
      checkId: check.id,
      status: 'not-runnable',
      output: `${result.missingExecutable} not found`,
      command: result.command,
    };
  }
  return {
    checkId: check.id,
    status: checkStatus(result),
    output: checkOutput(result),
    ...(result.command !== undefined && { command: result.command }),
    ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
  };
}

async function runCommandCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
  packageScripts: PackageScriptsReadinessInput,
  reviewCheck: boolean,
): Promise<CheckRunResult> {
  // A reviewer check runs under the reviewer policy, any stack's program, and is refused for a
  // changed script; a plan check keeps the plan policy, and a plan may add a script and check it.
  const refusal =
    (reviewCheck
      ? reviewerCommandRefusal(check.value)
      : checkCommandRefusal(check.value, {
          npmScriptsApproved: opts.npmScriptsApproved,
          packageScripts,
        })) ??
    (!reviewCheck || opts.base === undefined
      ? null
      : await changedDefinitionRefusal({
          command: check.value,
          base: opts.base,
          workspaceDir: opts.projectDir,
        }));
  if (refusal !== null) {
    return { checkId: check.id, status: 'refused', output: refusal, command: check.value };
  }
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
    return {
      checkId: check.id,
      status: 'pass',
      output: boundedOutputTail(output),
      command: check.value,
      exitCode: 0,
    };
  } catch (err: unknown) {
    if (processError.isExitCode(err)) {
      const output = [err.data.output, err.data.stderr]
        .filter((part) => part.trim().length > 0)
        .join('\n');
      return {
        checkId: check.id,
        status: 'fail',
        output: boundedOutputTail(output),
        command: check.value,
        ...(err.data.code !== null && { exitCode: err.data.code }),
      };
    }
    if (processError.isTimeout(err)) {
      return {
        checkId: check.id,
        status: 'fail',
        output: boundedOutputTail(err.message),
        command: check.value,
        timedOut: true,
      };
    }
    if (isENOENT(err) || processError.isNotFound(err)) {
      return {
        checkId: check.id,
        status: 'not-runnable',
        output: `${cmd} not found`,
        command: check.value,
      };
    }
    throw err;
  }
}

const RENDER_ID_PATTERN = /^[a-z0-9-]+$/;

async function runRenderCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
): Promise<CheckRunResult> {
  const template = opts.config.validation.render;
  if (template === undefined) {
    return { checkId: check.id, status: 'not-runnable', output: 'validation.render is not set' };
  }
  if (!RENDER_ID_PATTERN.test(check.value)) {
    return {
      checkId: check.id,
      status: 'refused',
      output: `render id "${check.value}" must match ^[a-z0-9-]+$`,
    };
  }
  const [cmd, ...templateArgs] = parseShellCommand(template);
  if (cmd === undefined) {
    return { checkId: check.id, status: 'refused', output: 'names no program' };
  }
  const executionId = randomUUID();
  const outDir = join(opts.projectDir, '.test-artifacts', 'ui', `render-${executionId}`);
  await mkdir(outDir, { recursive: true });
  const args = templateArgs.map((arg) => {
    if (arg === '{id}') return check.value;
    if (arg === '{out}') return outDir;
    return arg;
  });
  const command = [cmd, ...args].join(' ');
  let exitCode: number;
  let text: string;
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd: opts.projectDir,
      timeout: validationTimeout(opts.config),
      label: `check ${check.id}`,
      signal: opts.signal,
    });
    exitCode = 0;
    text = [stdout, stderr].filter((part) => part.trim().length > 0).join('\n');
  } catch (err: unknown) {
    if (processError.isExitCode(err)) {
      exitCode = err.data.code ?? 1;
      text = [err.data.output, err.data.stderr].filter((part) => part.trim().length > 0).join('\n');
    } else if (processError.isTimeout(err)) {
      return { checkId: check.id, status: 'fail', output: boundedOutputTail(err.message), command };
    } else if (isENOENT(err) || processError.isNotFound(err)) {
      return { checkId: check.id, status: 'not-runnable', output: `${cmd} not found`, command };
    } else {
      throw err;
    }
  }
  const destDir =
    opts.checkoutDir !== undefined && opts.sessionId !== undefined
      ? join(
          rendersDir({ projectDir: opts.checkoutDir, sessionId: opts.sessionId }, check.id),
          executionId,
        )
      : undefined;
  const artifacts: CheckRunArtifact[] = [];
  if (destDir !== undefined) {
    await mkdir(destDir, { recursive: true });
    const entries = await readdir(outDir, { recursive: true });
    const pngs = entries.filter((name) => name.toLowerCase().endsWith('.png')).sort();
    for (const rel of pngs) {
      const dest = join(destDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(outDir, rel), dest);
      artifacts.push({ path: dest, sha256: sha256Hex(await readFile(dest)) });
    }
  }
  return {
    checkId: check.id,
    status: exitCode === 0 ? 'pass' : 'fail',
    output: boundedOutputTail(text),
    command,
    exitCode,
    artifacts,
  };
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
  const reviewIds = new Set((opts.reviewChecks ?? []).map((check) => check.id));
  const results: CheckRunResult[] = [];
  const seen = new Set<string>();
  for (const checkId of checkIds) {
    if (seen.has(checkId)) continue;
    seen.add(checkId);
    const check = registry.get(checkId);
    if (check === undefined) {
      results.push({ checkId, status: 'unknown', output: `no check ${checkId}` });
    } else if (check.kind === 'render') {
      results.push(await runRenderCheck(check, opts, run));
    } else if (check.kind === 'cmd') {
      results.push(
        await runCommandCheck(check, opts, run, packageScripts, reviewIds.has(check.id)),
      );
    } else {
      results.push(await runTestCheck(check, opts, run, stageContext));
    }
  }
  return results;
}

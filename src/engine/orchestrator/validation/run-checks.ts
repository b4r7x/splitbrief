import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveApproveLevel, resolveEndChecks } from '../../../core/config/runtime/resolve.js';
import { rendersDir } from '../../../core/paths.js';
import { STAGE_TIMEOUT_MS } from '../../../core/pipeline-spec/gates.js';
import type { PackageScriptsReadinessInput } from '../../../core/readiness/checks/validation.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { Check, CheckStatus, Task } from '../../../core/schemas/task.js';
import type {
  DiscoveredValidation,
  ReviewChecksRecord,
  WorkflowState,
} from '../../../core/schemas/workflow.js';
import {
  captureText,
  processError,
  processOutputCapture,
  type ProcessOutputCapture,
} from '../../../lib/process/errors.js';
import { runCommand } from '../../../lib/process/spawn/run-command.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type { EventBus } from '../../events/types.js';
import type { RunBase } from '../isolation/base-tree.js';
import {
  commandTextRefusal,
  missingNpmScript,
  readPackageScripts,
} from '../planning/sanitize-discovered-validation.js';
import { RENDER_ID_PATTERN } from '../../spec/plan-checks.js';
import { changedDefinitionRefusal } from './changed-script.js';
import { failureKeys, type FailureKeys } from './extract-failure-keys.js';
import type { ValidationResult } from './result.js';
import { reviewerCommandRefusal } from './reviewer-command-policy.js';
import { NO_TEST_FILE_FOUND } from './commands.js';
import { buildStageContext, planTestCheck } from './run.js';
import { boundedOutputTail, notRunnableReason, runValidationStep } from './stage.js';
import { countCargoTests } from './test-failures.js';
import type { ValidationCommandRunner } from './types.js';

export type CheckRunArtifact = {
  path: string;
  sha256: string;
};

export type CheckRunResult = {
  checkId: string;
  output: string;
  command?: string | undefined;
  exitCode?: number | undefined;
  timedOut?: true | undefined;
  artifacts?: CheckRunArtifact[] | undefined;
  /** The failure keys the same command also showed at the run base. */
  preExisting?: readonly string[] | undefined;
  /** The same command's re-run at the run base. */
  base?: { output: string; exitCode?: number | undefined } | undefined;
  /** Not runnable because a program is missing (`notRunnableReason`): installing it is the fix. */
  missingProgram?: true | undefined;
} & (
  | {
      status: 'fail';
      /** The failure keys of the red, read from its whole capture; `output` keeps only its tail. */
      failure: FailureKeys;
    }
  | { status: Exclude<CheckStatus, 'fail'> }
);

export type RunChecksOptions = {
  task?: Task | undefined;
  tasks?: readonly Task[] | undefined;
  plan?: Plan | undefined;
  /** The reviewer checks as required `cmd` checks; a script the run changed refuses its check. */
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
  /**
   * Per `cmd` check id, the test files it runs alone when its command is the stack's test command
   * and the stack can select them; the next review runs the whole command.
   */
  testFiles?: ReadonlyMap<string, readonly string[]> | undefined;
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

function checkOutput(result: ValidationResult): string {
  return result.passed ? (result.output ?? '') : (result.error ?? result.output ?? '');
}

function validationTimeout(config: Config): number {
  return config.validation.timeoutMs ?? STAGE_TIMEOUT_MS;
}

type TestCheckPlan = ReturnType<typeof planTestCheck>;

async function runTestCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
  planned: TestCheckPlan,
): Promise<CheckRunResult> {
  if (planned.kind === 'skip' && planned.reason === NO_TEST_FILE_FOUND) {
    // The stack's tests run, but the workspace lacks the test file the check names: the change is
    // missing it, so the check fails and the builder or the reviewer answers it.
    const missing = `the workspace has no test file for ${check.value}`;
    return {
      checkId: check.id,
      status: 'fail',
      output: missing,
      failure: { keys: ['no test file'], placeholder: missing },
    };
  }
  if (planned.kind === 'skip') {
    return { checkId: check.id, status: 'not-runnable', output: planned.reason };
  }
  const result = await runValidationStep({
    cmd: planned.resolved.cmd,
    args: planned.args,
    cwd: opts.projectDir,
    timeout: validationTimeout(opts.config),
    runCommand: run,
    command: planned.command,
    signal: opts.signal,
  });
  if (result.notRunnable !== undefined) {
    return {
      checkId: check.id,
      status: 'not-runnable',
      output: result.notRunnable,
      command: result.command,
      missingProgram: true,
    };
  }
  // A test that ran shows in the visible counts. A check whose selection runs no test fails, so the
  // builder or the reviewer answers it; a cut-off output cannot show that one ran.
  if (
    result.passed &&
    planned.countsCargoTests &&
    countCargoTests(captureText(result.capture)) === 0
  ) {
    const noTest = result.capture.complete
      ? 'the command ran no test'
      : 'the test output was cut off before it showed a test that ran';
    return {
      checkId: check.id,
      status: 'fail',
      output: noTest,
      failure: { keys: ['no test ran'], placeholder: noTest },
      command: result.command,
    };
  }
  return {
    checkId: check.id,
    ...(result.passed
      ? { status: 'pass' as const }
      : {
          status: 'fail' as const,
          failure: failureKeys(
            { capture: result.capture, timedOut: result.timedOut, exitCode: result.exitCode },
            opts.projectDir,
          ),
        }),
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
  narrowed: TestCheckPlan | null,
): Promise<CheckRunResult> {
  // A reviewer check runs under the reviewer policy, any stack's program, and is refused for a
  // changed script; a plan check keeps the plan policy, and a plan may add a script and check it.
  const refusal = reviewCheck
    ? (reviewerCommandRefusal(check.value) ??
      (await changedDefinitionRefusal({
        command: check.value,
        base: opts.base,
        workspaceDir: opts.projectDir,
      })))
    : commandTextRefusal(check.value, opts.npmScriptsApproved);
  if (refusal !== null) {
    return { checkId: check.id, status: 'refused', output: refusal, command: check.value };
  }
  // The change lacks the script the check runs, so the check fails and a fix can add it.
  const missing = reviewCheck
    ? null
    : missingNpmScript(check.value, opts.npmScriptsApproved, packageScripts);
  if (missing !== null) {
    return {
      checkId: check.id,
      status: 'fail',
      output: missing,
      failure: { keys: ['no npm script'], placeholder: missing },
    };
  }
  if (narrowed !== null) return runTestCheck(check, opts, run, narrowed);
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
    return {
      checkId: check.id,
      status: 'pass',
      output: boundedOutputTail(captureText({ stdout, stderr, complete: true })),
      command: check.value,
      exitCode: 0,
    };
  } catch (err: unknown) {
    const notRunnable = notRunnableReason(err, cmd);
    if (notRunnable !== undefined) {
      return {
        checkId: check.id,
        status: 'not-runnable',
        output: notRunnable,
        command: check.value,
        missingProgram: true,
      };
    }
    if (processError.isExitCode(err)) {
      const capture = processOutputCapture(err.data);
      return {
        checkId: check.id,
        status: 'fail',
        output: boundedOutputTail(captureText(capture)),
        failure: failureKeys({ capture, exitCode: err.data.code ?? undefined }, opts.projectDir),
        command: check.value,
        ...(err.data.code !== null && { exitCode: err.data.code }),
      };
    }
    if (processError.isTimeout(err)) {
      return {
        checkId: check.id,
        status: 'fail',
        output: boundedOutputTail(err.message),
        failure: failureKeys(
          { capture: { stdout: '', stderr: '', complete: true }, timedOut: true },
          opts.projectDir,
        ),
        command: check.value,
        timedOut: true,
      };
    }
    throw err;
  }
}

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
  let capture: ProcessOutputCapture;
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd: opts.projectDir,
      timeout: validationTimeout(opts.config),
      label: `check ${check.id}`,
      signal: opts.signal,
    });
    exitCode = 0;
    capture = { stdout, stderr, complete: true };
  } catch (err: unknown) {
    const notRunnable = notRunnableReason(err, cmd);
    if (notRunnable !== undefined) {
      return {
        checkId: check.id,
        status: 'not-runnable',
        output: notRunnable,
        command,
        missingProgram: true,
      };
    }
    if (processError.isExitCode(err)) {
      exitCode = err.data.code ?? 1;
      capture = processOutputCapture(err.data);
    } else if (processError.isTimeout(err)) {
      return {
        checkId: check.id,
        status: 'fail',
        output: boundedOutputTail(err.message),
        failure: failureKeys(
          { capture: { stdout: '', stderr: '', complete: true }, timedOut: true },
          opts.projectDir,
        ),
        command,
      };
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
    ...(exitCode === 0
      ? { status: 'pass' as const }
      : {
          status: 'fail' as const,
          failure: failureKeys({ capture, exitCode }, opts.projectDir),
        }),
    output: boundedOutputTail(captureText(capture)),
    command,
    exitCode,
    artifacts,
  };
}

export function createCheckRunner(opts: RunChecksOptions): (check: Check) => {
  command: string;
  run: () => Promise<CheckRunResult>;
} {
  const run = opts.runCommand ?? runCommand;
  const stageContext = buildStageContext({
    projectDir: opts.projectDir,
    config: opts.config,
    discoveredValidation: opts.discoveredValidation,
    notices: { bus: opts.bus, phase: opts.phase },
  });
  const packageScripts = readPackageScripts(opts.projectDir);
  const reviewIds = new Set((opts.reviewChecks ?? []).map((check) => check.id));
  return (check) => {
    if (check.kind === 'render') {
      return { command: '', run: () => runRenderCheck(check, opts, run) };
    }
    if (check.kind === 'cmd') {
      const files = opts.testFiles?.get(check.id);
      const planned = files === undefined ? null : planTestCheck(files, stageContext);
      const narrowed =
        planned?.kind === 'run' &&
        planned.narrowed &&
        parseShellCommand(check.value).join(' ') ===
          [planned.resolved.cmd, ...planned.resolved.args].join(' ')
          ? planned
          : null;
      return {
        command: narrowed?.command ?? check.value,
        run: () =>
          runCommandCheck(check, opts, run, packageScripts, reviewIds.has(check.id), narrowed),
      };
    }
    const planned = planTestCheck([check.value], stageContext);
    return {
      command: planned.kind === 'run' ? planned.command : '',
      run: () => runTestCheck(check, opts, run, planned),
    };
  };
}

export async function runChecks(
  checkIds: readonly string[],
  opts: RunChecksOptions,
  onStart?: (check: Check, command: string) => void,
): Promise<CheckRunResult[]> {
  const prepare = createCheckRunner(opts);
  const registry = checkRegistry(opts);
  const results: CheckRunResult[] = [];
  const seen = new Set<string>();
  for (const checkId of checkIds) {
    if (seen.has(checkId)) continue;
    seen.add(checkId);
    const check = registry.get(checkId);
    if (check === undefined) {
      results.push({ checkId, status: 'unknown', output: `no check ${checkId}` });
    } else {
      const prepared = prepare(check);
      onStart?.(check, prepared.command);
      results.push(await prepared.run());
    }
  }
  return results;
}

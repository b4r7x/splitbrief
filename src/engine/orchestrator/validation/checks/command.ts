import type { PackageScriptsReadinessInput } from '../../../../core/readiness/checks/validation.js';
import type { Check } from '../../../../core/schemas/task.js';
import { captureText, processError, processOutputCapture } from '../../../../lib/process/errors.js';
import { parseShellCommand } from '../../../../utils/parse-shell-command.js';
import { missingNpmScript } from '../plan-policy/npm-scripts.js';
import { commandTextRefusal } from '../plan-policy/command.js';
import { changedDefinitionRefusal } from '../changed-script.js';
import { failureKeys } from '../extract-failure-keys.js';
import { runCommandOnce } from '../result-store.js';
import { reviewerCommandRefusal } from '../reviewer-policy/refusal.js';
import { boundedOutputTail, notRunnableReason } from '../stage.js';
import type { ValidationCommandRunner } from '../types.js';
import { runTestCheck } from './test.js';
import type { RunChecksOptions, TestCheckPlan, CheckRunResult } from './types.js';

export async function runCommandCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
  packageScripts: PackageScriptsReadinessInput,
  reviewCheck: boolean,
  narrowed: TestCheckPlan | null,
): Promise<CheckRunResult> {
  // A reviewer check runs under the reviewer policy, any stack's program, and is refused for a
  // changed script; a plan check keeps the plan policy, and a plan may add a script and check it.
  // At the run base every script is the one the run started from.
  const refusal = reviewCheck
    ? (reviewerCommandRefusal(check.value) ??
      (opts.results?.tree === 'run-base'
        ? null
        : await changedDefinitionRefusal({
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
  return runCommandOnce({
    store: opts.results,
    workspaceDir: opts.projectDir,
    checkId: check.id,
    command: check.value,
    run: () => spawnCommandCheck(check, opts, run, cmd, args),
  });
}

async function spawnCommandCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
  cmd: string,
  args: string[],
): Promise<CheckRunResult> {
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd: opts.projectDir,
      timeout: opts.config.validation.timeoutMs,
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

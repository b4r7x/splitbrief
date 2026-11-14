import type { Check } from '../../../../core/schemas/task.js';
import { captureText } from '../../../../lib/process/errors.js';
import { NO_TEST_FILE_FOUND } from '../commands.js';
import { failureKeys } from '../extract-failure-keys.js';
import { runCommandOnce } from '../result-store.js';
import type { ValidationResult } from '../types.js';
import { runValidationStep } from '../stage.js';
import { countCargoTests } from '../test-failures.js';
import type { ValidationCommandRunner } from '../types.js';
import type { RunChecksOptions, TestCheckPlan, CheckRunResult } from './types.js';

function checkOutput(result: ValidationResult): string {
  return result.passed ? (result.output ?? '') : (result.error ?? result.output ?? '');
}

export async function runTestCheck(
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
  return runCommandOnce({
    store: opts.results,
    workspaceDir: opts.projectDir,
    checkId: check.id,
    command: planned.command,
    run: () => spawnTestCheck(check, opts, run, planned),
  });
}

async function spawnTestCheck(
  check: Check,
  opts: RunChecksOptions,
  run: ValidationCommandRunner,
  planned: Extract<TestCheckPlan, { kind: 'run' }>,
): Promise<CheckRunResult> {
  const result = await runValidationStep({
    cmd: planned.resolved.cmd,
    args: planned.args,
    cwd: opts.projectDir,
    timeout: opts.config.validation.timeoutMs,
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
    ...(result.timedOut === true && { timedOut: true }),
  };
}

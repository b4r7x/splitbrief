import { isENOENT, processError } from '../../../lib/process/errors.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByTailLines } from '../../../utils/truncate.js';
import { CAPTURE_LIMITS } from '../../../core/pipeline-spec/gates.js';
import type { CommandSource } from '../../../core/validation/stage-command.js';
import { failingTestLabel, parseFailingTests } from './test-failures.js';
import type { ValidationResult } from './result.js';
import type { ValidationCommandRunner } from './types.js';

export type ValidationStepResult = ValidationResult & {
  missingExecutable?: string | undefined;
};

export const MAX_VALIDATION_OUTPUT_CHARS = CAPTURE_LIMITS.outputChars;
export const MAX_TEST_TAIL_LINES = CAPTURE_LIMITS.testTailLines;

export function boundedOutputTail(text: string): string {
  const tail =
    text.length <= MAX_VALIDATION_OUTPUT_CHARS ? text : text.slice(-MAX_VALIDATION_OUTPUT_CHARS);
  return redactSecrets(tail);
}

function sanitizeTestOutput(text: string): string {
  return boundedOutputTail(truncateByTailLines(text, MAX_TEST_TAIL_LINES));
}

/** Runs the command of a planner `test` check: a summary-last runner keeps its tail lines. */
export async function runValidationStep(opts: {
  cmd: string;
  args: string[];
  source: CommandSource;
  cwd: string;
  timeout: number;
  runCommand: ValidationCommandRunner;
  command: string;
  signal?: AbortSignal | undefined;
}): Promise<ValidationStepResult> {
  const { cmd, args, source, cwd, timeout, runCommand, command, signal } = opts;
  const stage = 'test';
  try {
    const { stdout, stderr } = await runCommand(cmd, args, {
      cwd,
      timeout,
      label: `${stage} validation`,
      signal,
    });
    const green = [stdout, stderr].filter((part) => part.trim().length > 0).join('\n');
    return { passed: true, stage, output: sanitizeTestOutput(green), command, exitCode: 0 };
  } catch (err: unknown) {
    if (isENOENT(err) || processError.isNotFound(err)) {
      if (source === 'config') {
        return {
          passed: false,
          stage,
          error: `Configured ${stage} command not found: ${cmd}`,
          output: '',
          command,
          missingExecutable: cmd,
        };
      }
      const notFoundReason = `${cmd} not found, skipping ${stage}`;
      return {
        passed: true,
        stage,
        skipped: true,
        skippedReason: notFoundReason,
        output: notFoundReason,
        command,
        missingExecutable: cmd,
      };
    }
    if (processError.isTimeout(err)) {
      return {
        passed: false,
        stage,
        timedOut: true,
        error: boundedOutputTail(err.message),
        output: '',
        command,
      };
    }
    if (processError.isExitCode(err)) {
      const { output, stderr } = err.data;
      const stdout = String(output ?? '');
      const rawOutput = [stdout, String(stderr ?? '')]
        .filter((part) => part.trim().length > 0)
        .join('\n');
      const failingTests = parseFailingTests(rawOutput);
      const detail =
        failingTests.length > 0
          ? failingTests
              .map(
                (test) =>
                  `FAIL  ${failingTestLabel(test)}${test.message === '' ? '' : `\n${test.message}`}`,
              )
              .join('\n\n')
          : truncateByTailLines(rawOutput, MAX_TEST_TAIL_LINES).trim();
      return {
        passed: false,
        stage,
        failingTests,
        output: sanitizeTestOutput(stdout),
        error: boundedOutputTail(detail),
        command,
        ...(err.data.code !== null && { exitCode: err.data.code }),
      };
    }
    throw err;
  }
}

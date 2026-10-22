import {
  captureText,
  isENOENT,
  processError,
  processOutputCapture,
  type ProcessOutputCapture,
} from '../../../lib/process/errors.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByTailLines } from '../../../utils/truncate.js';
import { CAPTURE_LIMITS } from '../../../core/pipeline-spec/gates.js';
import { relativeToDir } from './extract-failure-keys.js';
import { failingTestLabel, parseFailingTests } from './test-failures.js';
import type { ValidationResult } from './result.js';
import type { ValidationCommandRunner } from './types.js';

export type ValidationStepResult = ValidationResult & {
  /** Why the command could not run: see `notRunnableReason`. */
  notRunnable?: string | undefined;
  capture: ProcessOutputCapture;
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

const MISSING_PROGRAM_LINE = /not found|No such file or directory/;

/**
 * Why a check's command could not run, or undefined when it ran. The program itself is missing
 * (ENOENT), or it started and exited 127 because a program it calls is missing, as the shell of a
 * package script does: the last stderr line with the shell's missing-program message names that
 * program, past the trailer line a package manager such as yarn or bun writes after it.
 */
export function notRunnableReason(err: unknown, cmd: string): string | undefined {
  if (isENOENT(err)) return `${cmd} not found`;
  if (!processError.isExitCode(err) || err.data.code !== 127) return undefined;
  const lines = err.data.stderr
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const line = lines.findLast((part) => MISSING_PROGRAM_LINE.test(part)) ?? lines.at(-1);
  return line === undefined ? `${cmd} exited 127` : boundedOutputTail(line);
}

/** Runs the command of a planner `test` check: a summary-last runner keeps its tail lines. */
export async function runValidationStep(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  timeout: number;
  runCommand: ValidationCommandRunner;
  command: string;
  signal?: AbortSignal | undefined;
}): Promise<ValidationStepResult> {
  const { cmd, args, cwd, timeout, runCommand, command, signal } = opts;
  try {
    const { stdout, stderr, stdoutMetadata, stderrMetadata } = await runCommand(cmd, args, {
      cwd,
      timeout,
      label: 'test validation',
      signal,
    });
    const capture = {
      stdout,
      stderr,
      complete: stdoutMetadata?.truncated !== true && stderrMetadata?.truncated !== true,
    };
    return {
      passed: true,
      output: sanitizeTestOutput(captureText(capture)),
      capture,
      command,
      exitCode: 0,
    };
  } catch (err: unknown) {
    const notRunnable = notRunnableReason(err, cmd);
    if (notRunnable !== undefined) {
      return {
        passed: false,
        output: '',
        capture: { stdout: '', stderr: '', complete: true },
        command,
        notRunnable,
      };
    }
    if (processError.isTimeout(err)) {
      return {
        passed: false,
        timedOut: true,
        error: boundedOutputTail(err.message),
        output: '',
        capture: { stdout: '', stderr: '', complete: true },
        command,
      };
    }
    if (processError.isExitCode(err)) {
      const { output } = err.data;
      const stdout = String(output ?? '');
      const capture = processOutputCapture(err.data);
      const failingTests = parseFailingTests(relativeToDir(captureText(capture), cwd));
      const detail =
        failingTests.length > 0
          ? failingTests
              .map(
                (test) =>
                  `FAIL  ${failingTestLabel(test)}${test.message === '' ? '' : `\n${test.message}`}`,
              )
              .join('\n\n')
          : truncateByTailLines(captureText(capture), MAX_TEST_TAIL_LINES).trim();
      return {
        passed: false,
        output: sanitizeTestOutput(stdout),
        capture,
        error: boundedOutputTail(detail),
        command,
        ...(err.data.code !== null && { exitCode: err.data.code }),
      };
    }
    throw err;
  }
}

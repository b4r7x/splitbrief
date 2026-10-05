import { isENOENT, processError } from '../../../lib/process/errors.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByTailLines } from '../../../utils/truncate.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import { CAPTURE_LIMITS } from '../../../core/pipeline-spec/gates.js';
import type { Stack } from '../../../core/validation/stacks/types.js';
import { isMissingSubcommand, type CommandSource } from '../../../core/validation/stage-command.js';
import { extractNamedChangedFiles } from './extract-named-changed-files.js';
import type { ValidationResult } from './result.js';
import type { ValidationCommandRunner } from './types.js';

export type ValidationStepResult = ValidationResult & {
  missingExecutable?: string | undefined;
};

export const MAX_VALIDATION_OUTPUT_CHARS = CAPTURE_LIMITS.outputChars;
export const MAX_TEST_TAIL_LINES = CAPTURE_LIMITS.testTailLines;

// A failing runner prints the diagnostic it wants quoted last, so the captured
// output is a tail, never the head.
export function boundedOutputTail(text: string): string {
  const tail =
    text.length <= MAX_VALIDATION_OUTPUT_CHARS ? text : text.slice(-MAX_VALIDATION_OUTPUT_CHARS);
  return redactSecrets(tail);
}

function sanitizeStageOutput(stage: ValidationStage, text: string): string {
  const tail = stage === 'test' ? truncateByTailLines(text, MAX_TEST_TAIL_LINES) : text;
  return boundedOutputTail(tail);
}

function selectFailureDetail(stage: ValidationStage, stdout: string, stderr: string): string {
  if (stage === 'test') {
    const combined = [stdout, stderr].filter((part) => part.trim().length > 0).join('\n');
    return truncateByTailLines(combined, MAX_TEST_TAIL_LINES).trim();
  }
  return (stderr || stdout).trim();
}

export function skippedStage(stage: ValidationStage, reason: string): ValidationResult {
  return {
    passed: true,
    stage,
    skipped: true,
    skippedReason: reason,
    output: `skipped ${stage}: ${reason}`,
  };
}

export async function runValidationStep(opts: {
  stage: ValidationStage;
  cmd: string;
  args: string[];
  source: CommandSource;
  cwd: string;
  timeout: number;
  runCommand: ValidationCommandRunner;
  command: string;
  stack?: Stack | null | undefined;
  signal?: AbortSignal | undefined;
  changedFiles?: readonly string[] | undefined;
}): Promise<ValidationStepResult> {
  const {
    stage,
    cmd,
    args,
    source,
    cwd,
    timeout,
    runCommand,
    command,
    stack,
    signal,
    changedFiles,
  } = opts;
  try {
    const { stdout, stderr } = await runCommand(cmd, args, {
      cwd,
      timeout,
      label: `${stage} validation`,
      signal,
    });
    const green = [stdout, stderr].filter((part) => part.trim().length > 0).join('\n');
    return { passed: true, stage, output: sanitizeStageOutput(stage, green), command, exitCode: 0 };
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
        error: boundedOutputTail(err.message),
        output: '',
        command,
      };
    }
    if (processError.isExitCode(err)) {
      const { output, stderr } = err.data;
      if (source !== 'config' && isMissingSubcommand(stack, err.data.code, String(stderr ?? ''))) {
        const unavailableReason = `${cmd} subcommand unavailable, skipping ${stage}`;
        return {
          passed: true,
          stage,
          skipped: true,
          skippedReason: unavailableReason,
          output: unavailableReason,
          command,
        };
      }
      const stdout = String(output ?? '');
      const errText = selectFailureDetail(stage, stdout, String(stderr ?? ''));
      const rawOutput = [stdout, String(stderr ?? '')]
        .filter((part) => part.trim().length > 0)
        .join('\n');
      return {
        passed: false,
        stage,
        output: sanitizeStageOutput(stage, stdout),
        error: boundedOutputTail(errText),
        command,
        ...(err.data.code !== null && { exitCode: err.data.code }),
        ...(changedFiles !== undefined && {
          failureFiles: extractNamedChangedFiles(rawOutput, changedFiles),
        }),
      };
    }
    throw err;
  }
}

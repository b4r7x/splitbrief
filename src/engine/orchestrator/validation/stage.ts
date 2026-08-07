import { isENOENT, processError } from '../../../lib/process/errors.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars, truncateByTailLines } from '../../../utils/truncate.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import { extractNamedChangedFiles } from './extract-named-changed-files.js';
import type { ValidationResult } from './result.js';
import type { CommandSource } from './commands.js';
import type { ValidationCommandRunner } from './types.js';

const MISSING_SUBCOMMAND_EXIT_CODE = 101;
const MAX_VALIDATION_OUTPUT_CHARS = 4096;
const MAX_TEST_FAILURE_TAIL_LINES = 40;

function isMissingSubcommand(code: number | null, stderr: string): boolean {
  return code === MISSING_SUBCOMMAND_EXIT_CODE && /no such command/i.test(stderr);
}

function sanitizeValidationOutput(text: string): string {
  return redactSecrets(truncateByChars(text, MAX_VALIDATION_OUTPUT_CHARS));
}

function selectFailureDetail(stage: ValidationStage, stdout: string, stderr: string): string {
  if (stage === 'test') {
    const combined = [stdout, stderr].filter((part) => part.trim().length > 0).join('\n');
    return truncateByTailLines(combined, MAX_TEST_FAILURE_TAIL_LINES).trim();
  }
  return (stderr || stdout).trim();
}

export function skippedStage(stage: ValidationStage, reason: string): ValidationResult {
  return { passed: true, stage, skipped: true, output: `skipped ${stage}: ${reason}` };
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
  signal?: AbortSignal | undefined;
  changedFiles?: readonly string[] | undefined;
}): Promise<ValidationResult> {
  const { stage, cmd, args, source, cwd, timeout, runCommand, command, signal, changedFiles } =
    opts;
  try {
    const { stdout } = await runCommand(cmd, args, {
      cwd,
      timeout,
      label: `${stage} validation`,
      signal,
    });
    return { passed: true, stage, output: sanitizeValidationOutput(stdout), command };
  } catch (err: unknown) {
    if (isENOENT(err) || processError.isNotFound(err)) {
      if (source === 'config') {
        return {
          passed: false,
          stage,
          error: `Configured ${stage} command not found: ${cmd}`,
          output: '',
          command,
        };
      }
      return {
        passed: true,
        stage,
        skipped: true,
        output: `${cmd} not found, skipping ${stage}`,
        command,
      };
    }
    if (processError.isTimeout(err)) {
      return {
        passed: false,
        stage,
        error: sanitizeValidationOutput(err.message),
        output: '',
        command,
      };
    }
    if (processError.isExitCode(err)) {
      const { output, stderr } = err.data;
      if (source !== 'config' && isMissingSubcommand(err.data.code, String(stderr ?? ''))) {
        return {
          passed: true,
          stage,
          skipped: true,
          output: `${cmd} subcommand unavailable, skipping ${stage}`,
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
        output: sanitizeValidationOutput(stdout),
        error: sanitizeValidationOutput(errText),
        command,
        ...(changedFiles !== undefined && {
          failureFiles: extractNamedChangedFiles(rawOutput, changedFiles),
        }),
      };
    }
    throw err;
  }
}

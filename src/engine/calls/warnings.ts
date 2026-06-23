import { RUNNER_CALL_MESSAGE_MAX_LENGTH, RunnerCallWarningSchema } from './schema.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { redactSecretsWithMetadata } from '../../utils/redact.js';
import type { RunnerCallWarning, RunnerCallWarningInput } from './types.js';

export function normalizeRunnerCallWarning(input: RunnerCallWarningInput): RunnerCallWarning {
  const message = boundedRunnerCallWarningMessage(input.message);
  const redacted = input.redacted === true || message.redacted;
  return RunnerCallWarningSchema.parse({
    ...input,
    message: message.text,
    ...(redacted && { redacted: true }),
  });
}

export function showsRunnerCallWarningOnPrimarySurface(warning: RunnerCallWarning): boolean {
  return (
    warning.surface === 'activity' ||
    warning.surface === 'status' ||
    warning.surface === 'transcript'
  );
}

function boundedRunnerCallWarningMessage(message: string): { text: string; redacted: boolean } {
  const clean = redactSecretsWithMetadata(stripTerminalControls(message));
  if (clean.text.length <= RUNNER_CALL_MESSAGE_MAX_LENGTH) return clean;
  return {
    text: `${clean.text.slice(0, RUNNER_CALL_MESSAGE_MAX_LENGTH - 3)}...`,
    redacted: clean.redacted,
  };
}

import { RUNNER_CALL_MESSAGE_MAX_LENGTH, RunnerCallWarningSchema } from './schema.js';
import type { RunnerCallWarning, RunnerCallWarningInput } from './types.js';

export function normalizeRunnerCallWarning(input: RunnerCallWarningInput): RunnerCallWarning {
  return RunnerCallWarningSchema.parse({
    ...input,
    message: boundedRunnerCallWarningMessage(input.message),
  });
}

export function showsRunnerCallWarningOnPrimarySurface(warning: RunnerCallWarning): boolean {
  return (
    warning.surface === 'activity' ||
    warning.surface === 'status' ||
    warning.surface === 'transcript'
  );
}

function boundedRunnerCallWarningMessage(message: string): string {
  if (message.length <= RUNNER_CALL_MESSAGE_MAX_LENGTH) return message;
  return `${message.slice(0, RUNNER_CALL_MESSAGE_MAX_LENGTH - 3)}...`;
}

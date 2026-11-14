import { matches, error, type AppError } from '../../../utils/error.js';
import type { SpawnPipeExit, SpawnPipeFatalSignal, SpawnPipeFatalState } from './types.js';

const isStdinIncompleteKind = matches('process-stdin-incomplete');

export const spawnPipeError = {
  stdinIncomplete: (cause?: unknown, exit?: SpawnPipeExit) =>
    error(
      'process-stdin-incomplete',
      'Process stdin closed before all input was delivered',
      exit,
      cause,
    ),
  stdinClosed: () => error('process-stdin-closed', 'Process stdin is closed'),
  isStdinClosed: matches('process-stdin-closed'),
  isStdinIncomplete: (
    err: unknown,
  ): err is AppError<'process-stdin-incomplete', SpawnPipeExit | undefined> =>
    isStdinIncompleteKind(err),
} as const;

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function defaultFatalRemediation(state: SpawnPipeFatalState): string {
  switch (state) {
    case 'output-budget-breach':
      return 'The tool wrote more output than its limit allows and was stopped. Narrow what it was asked to print, then retry.';
    case 'protocol-failure':
      return 'Check the CLI version and output protocol, then retry.';
    case 'callback-failure':
      return 'Resolve the callback error, then retry.';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function isFatalSignal(value: unknown): value is SpawnPipeFatalSignal {
  if (typeof value !== 'object' || value === null) return false;
  if (!('state' in value) || !('remediation' in value)) return false;
  const state = value.state;
  return (
    (state === 'output-budget-breach' ||
      state === 'protocol-failure' ||
      state === 'callback-failure') &&
    typeof value.remediation === 'string'
  );
}

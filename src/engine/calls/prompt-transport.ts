import { error } from '../../utils/error.js';
import { boundedRunnerCallMessage, createRunnerCallCredentialRedactor } from './status.js';

export function stdinPromptTransportCallError(
  label: 'CLI' | 'Command',
  stderr: string,
  credentialValues: readonly string[] = [],
) {
  const redact = createRunnerCallCredentialRedactor(credentialValues);
  const diagnostic = redact(stderr.trim());
  const reason = `${label} prompt could not be fully delivered through stdin`;
  return {
    code: 'prompt-transport-error',
    message: boundedRunnerCallMessage(diagnostic === '' ? reason : `${reason}: ${diagnostic}`),
    promptTransport: { source: 'stdin', stderr: boundedRunnerCallMessage(diagnostic) },
  } as const;
}

export function stdinPromptTransportError(stderr: string, cause: Error) {
  const failure = stdinPromptTransportCallError('Command', stderr);
  return error(failure.code, failure.message, { error: failure }, cause);
}

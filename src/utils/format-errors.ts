import { redactSecrets } from './redact.js';

export function toErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

export const labelError = (action: string, err: unknown): string =>
  `${action}: ${toErrorMessage(err)}`;

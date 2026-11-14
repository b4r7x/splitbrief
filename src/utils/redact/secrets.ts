import { replaceAssignedSecret, ASSIGNED_SECRET_PATTERN } from './assignment.js';
import { KEY_PATTERNS } from './key-patterns.js';

export const DEFAULT_REDACTION_MARKER = '***REDACTED***';

export interface RedactSecretsOptions {
  marker?: string | undefined;
}

export interface RedactSecretsResult {
  text: string;
  redacted: boolean;
}

export function redactSecretsWithMetadata(
  msg: string,
  opts: RedactSecretsOptions = {},
): RedactSecretsResult {
  const marker = opts.marker ?? DEFAULT_REDACTION_MARKER;
  let result = msg;
  let redacted = false;
  const previouslyRedactedValues = new Set<string>();
  for (const { pattern, replacement } of KEY_PATTERNS) {
    const replacementValue = replacement(marker);
    result = result.replace(pattern, (...args) => {
      redacted = true;
      const replacedValue =
        typeof replacementValue === 'string'
          ? replacementValue
          : replacementValue(args[0], ...args.slice(1));
      previouslyRedactedValues.add(replacedValue);
      return replacedValue;
    });
  }
  const assignedSecretReplacement = replaceAssignedSecret(marker, previouslyRedactedValues);
  result = result.replace(
    ASSIGNED_SECRET_PATTERN,
    (match, prefix: string, value: string, offset: number, fullString: string) => {
      const replacedValue = assignedSecretReplacement(match, prefix, value, offset, fullString);
      if (replacedValue !== match) redacted = true;
      return replacedValue;
    },
  );
  return { text: result, redacted };
}

export function redactSecrets(msg: string): string {
  return redactSecretsWithMetadata(msg).text;
}

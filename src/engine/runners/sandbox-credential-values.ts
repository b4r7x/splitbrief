/**
 * Internal-only metadata attached to a sandbox environment for parent-side
 * redaction. It is non-enumerable, never copied into a child process, and is
 * deliberately kept out of the public environment key space.
 */
export const SANDBOX_CREDENTIAL_VALUES = Symbol('splitbrief.sandboxCredentialValues');

const MAX_STATE_REDACTION_VALUE_BYTES = 8 * 1024 * 1024;
/**
 * Bridged state files carry long opaque tokens next to short descriptive
 * values — `subscriptionType: "max"`, `type: "oauth"`. Redacting those would
 * shred every runner delta containing "max" or "oauth", so only values long
 * enough to be a credential are handed to the redactor.
 */
const MIN_STATE_REDACTION_VALUE_LENGTH = 12;

export function addStateRedactionValue(candidate: string, values: Set<string>): void {
  if (candidate.length < MIN_STATE_REDACTION_VALUE_LENGTH) return;
  if (Buffer.byteLength(candidate, 'utf8') > MAX_STATE_REDACTION_VALUE_BYTES) return;
  values.add(candidate);
}

export function sandboxCredentialValues(environment: unknown): readonly string[] {
  if (typeof environment !== 'object' || environment === null) return [];
  let value: unknown;
  try {
    value = Reflect.get(environment, SANDBOX_CREDENTIAL_VALUES);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
}

export function collectStateStrings(value: unknown, values: Set<string>): void {
  if (typeof value === 'string') {
    addStateRedactionValue(value, values);
    // A composite value ("Bearer <token>") reaches the child as its token
    // alone, so keep the credential-shaped parts as well.
    for (const token of value.split(/[^\p{L}\p{N}_./:+@=-]+/u)) {
      addStateRedactionValue(token, values);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStateStrings(entry, values);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const entry of Object.values(value)) collectStateStrings(entry, values);
}

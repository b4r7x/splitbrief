import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { isRecord } from '../../../utils/type-guards.js';
import { isInlineApiKey } from '../credentials.js';

/**
 * Persisted detection cache keys embed these identities, so they must be
 * stable across processes: two loads of the same config content must produce
 * the same id, or every restart (and every in-session config save) reads the
 * cache under a key no other process can reproduce and cold-starts discovery.
 * Inline credential values are replaced by a digest of the secret before
 * hashing — the id names the config's shape and tracks a key rotation, never
 * carries key material — and both digests are truncated well below the cache
 * scanner's 64-hex credential heuristic.
 */
export function contentIdentityId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256Hex(canonicalJSON(redactInlineApiKeys(value))).slice(0, 16)}`;
}

function redactInlineApiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInlineApiKeys);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      key === 'apiKey' && typeof entry === 'string' && isInlineApiKey(entry)
        ? `inline:${sha256Hex(entry).slice(0, 16)}`
        : redactInlineApiKeys(entry);
  }
  return out;
}

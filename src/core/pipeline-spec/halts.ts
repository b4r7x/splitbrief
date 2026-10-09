export type HaltKind = 'input-too-large' | 'auth' | 'usage' | 'missing-model' | 'spawn';

/**
 * Phrases that end a run instead of entering the retry ladder. Lowercase, matched
 * as case-insensitive substrings so a bare status number never classifies on its
 * own — NDJSON logs are full of them. The tail of a failed run's own stdout is
 * matched against this list, so every phrase must be one a tool emits only when
 * it halts: a bare domain noun a brief can carry ("billing", "rate limit") would
 * stamp an ordinary gate failure as a quota halt and skip the ladder. The same
 * rule excludes strings the OS or a shelled-out command emits under the tool —
 * "unauthorized" (a git remote refusing a push), "permission denied" (EACCES on
 * a cache directory) — so a permission halt is the tool's own refusal wording
 * ("requires permissions", "use --yolo") and an auth halt is a 401 spelling.
 */
export const HALT_SIGNATURES = {
  inputTooLarge: ['input_too_large', 'input exceeds the maximum length'],
  auth: [
    'access token could not be refreshed',
    'log out and sign in again',
    '401 unauthorized',
    'please run /login',
    'invalid api key',
    'oauth token has expired',
    'oauth token revoked',
    'authentication_error',
    'not logged in',
    'not authenticated',
    'http 401',
    'status 401',
    '"status":401',
    'login required',
    'authentication failed',
  ],
  usage: [
    'rate limit exceeded',
    'rate limit reached',
    'usage limit',
    'quota exceeded',
    'too many requests',
    'insufficient_quota',
    'exceeded your current quota',
    'credit balance is too low',
    'http 429',
    'status 429',
    '"status":429',
    'insufficient credits',
    'quota reached',
    'resource_exhausted',
    'exhausted your',
  ],
  missingModel: ['unknown model', 'model not found', 'invalid model'],
  spawnFailure: [
    'requires permissions',
    'use --yolo',
    'blocked by permissions',
    'not allowed in this mode',
    'unknown option',
    'unknown flag',
    'unrecognized argument',
    // Claude Code's refusal under `sandbox.failIfUnavailable`, which the implementer seat sets.
    // Without it Claude Code prints `⚠ Sandbox disabled: sandbox is enabled but …` and runs on,
    // so that reason must not match.
    'sandbox required but unavailable',
  ],
} as const satisfies Record<string, readonly string[]>;

export const HALT_TAIL_LINES = 60;

const HALT_GROUPS: readonly (readonly [HaltKind, readonly string[]])[] = [
  ['input-too-large', HALT_SIGNATURES.inputTooLarge],
  ['auth', HALT_SIGNATURES.auth],
  ['usage', HALT_SIGNATURES.usage],
  ['missing-model', HALT_SIGNATURES.missingModel],
  ['spawn', HALT_SIGNATURES.spawnFailure],
];

export function classifyHaltSignature(lines: readonly string[]): HaltKind | null {
  const text = lines.slice(-HALT_TAIL_LINES).join('\n').toLowerCase();
  for (const [kind, phrases] of HALT_GROUPS) {
    if (phrases.some((phrase) => text.includes(phrase))) return kind;
  }
  return null;
}

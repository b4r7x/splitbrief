import { HALT_SIGNATURES } from '../../core/pipeline-spec/halts.js';
import type { SeatAccountCause } from '../../core/recovery/account-cause.js';
import { isAuthFailureDiagnostic } from './auth-failure.js';
import { looksOfflineDiagnostic } from './cli-tools/registry.js';
import type { RunnerFailureOutcomeState } from './errors.js';
import {
  hasUsageLimitNounCorroboration,
  isUsageLimitDiagnostic,
  parseUsageLimitReset,
} from './usage-limit.js';

/** Where a failed seat call's words came from; tail sources are the tool's own last lines. */
export type SeatFailureSource = 'result-error' | 'thrown' | 'stderr-tail' | 'stdout-tail';

export type SeatFailureClassification =
  | Readonly<{ class: 'authoritative' }>
  | Readonly<{ class: 'account'; cause: SeatAccountCause }>
  | Readonly<{ class: 'rate-limited'; resetAt: Date }>
  | Readonly<{ class: 'transient' }>
  | Readonly<{ class: 'other' }>;

export type SeatFailureInput = Readonly<{
  message: string;
  code?: string | undefined;
  status?: number | undefined;
  providerType?: string | undefined;
  outcome?: RunnerFailureOutcomeState | undefined;
  source: SeatFailureSource;
}>;

/**
 * Outcomes a failure already carries as its own verdict: no retry, no wait and
 * no re-reading of the words can change them. Every other outcome is either
 * explained by the message or final on its own.
 */
const AUTHORITATIVE_OUTCOMES: ReadonlySet<string> = new Set([
  'user-abort',
  'implementer-left-isolation',
  'checkout-changed',
  'implementer-recipe-invalid',
  'input-too-large',
  'missing-model',
  'no-progress-cut',
]);

/**
 * Account refusals a provider prints when it will not serve the call at all:
 * an empty balance, an inactive or hard-limited billing state, or a suspended
 * account. These are diagnostic-only — the stdout tail carries test logs — and
 * they outrank a 429 in the same text, because retrying cannot restore them.
 */
const ACCOUNT_PHRASES: readonly (readonly [SeatAccountCause, string])[] = [
  ['balance', 'insufficient balance'],
  ['balance', 'insufficient credits'],
  ['balance', 'credit balance is too low'],
  ['balance', 'out of credits'],
  ['billing', 'payment required'],
  ['billing', 'billing_hard_limit'],
  ['billing', 'billing_not_active'],
  ['billing', 'account suspended'],
];

/** Transient troubles that name the network itself, not a whole-call timeout. */
const TRANSIENT_NETWORK_MARKERS: readonly string[] = [
  'connection reset',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'fetch failed',
  'eai_again',
  'enotfound',
  'etimedout',
  'connect timed out',
  'connection timed out',
];

/**
 * Outcomes whose message still decides: a crashed tool and a dropped protocol
 * can both name a network fault, and a limit failure retries only when it names
 * no reset. Every other outcome is final for this classifier.
 */
const MESSAGE_CLASSIFIED_OUTCOMES: ReadonlySet<RunnerFailureOutcomeState> = new Set([
  'non-zero-exit',
  'protocol-failure',
  'usage-limit',
]);

function isTailSource(source: SeatFailureSource): boolean {
  return source === 'stderr-tail' || source === 'stdout-tail';
}

function httpStatusOf(message: string): number | null {
  const contextual = /(?:http|status(?:\s*code)?)[^0-9]{0,4}(\d{3})\b/i.exec(message);
  if (contextual?.[1] !== undefined) return Number.parseInt(contextual[1], 10);
  const parenthesized = /\((\d{3})\)/.exec(message);
  if (parenthesized?.[1] !== undefined) return Number.parseInt(parenthesized[1], 10);
  if (/\b429\b/.test(message)) return 429;
  return /\b408\b/.test(message) ? 408 : null;
}

/**
 * Whether the words name an exhausted account rather than a momentary refusal.
 * Tail sources match only `HALT_SIGNATURES` phrases, so a transcript's
 * `billing/` path or a shelled-out `permission denied` never classifies. A
 * strong limit phrase that is only an HTTP 429 capacity rejection — Claude
 * Code's "Request rejected (429)" — is not exhaustion; it is retried.
 */
function isExhaustion(input: SeatFailureInput, text: string): boolean {
  const haltUsage = HALT_SIGNATURES.usage.some((phrase) => text.includes(phrase));
  if (isTailSource(input.source)) return haltUsage;
  if (haltUsage) return true;
  if (!isUsageLimitDiagnostic(input.message)) return false;
  return !/\b429\b/.test(text) || hasUsageLimitNounCorroboration(text);
}

function isAuthPhrase(input: SeatFailureInput, text: string): boolean {
  if (isTailSource(input.source)) {
    return HALT_SIGNATURES.auth.some((phrase) => text.includes(phrase));
  }
  return isAuthFailureDiagnostic(input.message);
}

function rateLimitedReset(input: SeatFailureInput, text: string): Date | null {
  const signal = input.status === 429 || /\b429\b/.test(text) || isExhaustion(input, text);
  if (!signal) return null;
  return parseUsageLimitReset(input.message);
}

function accountCause(input: SeatFailureInput, text: string): SeatAccountCause | null {
  if (input.status === 402) return 'balance';
  if (input.status === 401 || input.status === 403) return 'auth';
  if (isAuthPhrase(input, text)) return 'auth';
  if (!isTailSource(input.source)) {
    for (const [cause, phrase] of ACCOUNT_PHRASES) {
      if (text.includes(phrase)) return cause;
    }
  }
  // A limit with a parseable reset is waited out, not declared account-dead.
  if (rateLimitedReset(input, text) !== null) return null;
  if (isExhaustion(input, text)) return 'quota';
  // A 429 status is a refusal even when its body matches no known phrase; a
  // bare number in the text without a status is left to the transient arm.
  if (input.status === 429) return 'quota';
  if (input.providerType === 'provider.quota') return 'quota';
  return null;
}

function isTransient(input: SeatFailureInput, text: string): boolean {
  if (input.outcome !== undefined && !MESSAGE_CLASSIFIED_OUTCOMES.has(input.outcome)) {
    return false;
  }
  if (looksOfflineDiagnostic(input.message)) return true;
  if (TRANSIENT_NETWORK_MARKERS.some((marker) => text.includes(marker))) return true;
  const status = httpStatusOf(input.message);
  if (status === null) return false;
  if (status === 429) {
    return isUsageLimitDiagnostic(input.message) || hasUsageLimitNounCorroboration(text);
  }
  return status === 408 || (status >= 500 && status <= 599);
}

/**
 * The one classifier every failed seat call routes through, whatever the tool
 * or runner kind. The precedence is authoritative, then account, then
 * rate-limited, then transient, then other: an outcome that is its own verdict
 * is never retried, an account refusal outranks a 429 in the same text, and a
 * limit with a parseable reset is rate-limited so it can be waited out.
 */
export function classifySeatFailure(input: SeatFailureInput): SeatFailureClassification {
  const text = input.message.toLowerCase();
  if (input.outcome !== undefined && AUTHORITATIVE_OUTCOMES.has(input.outcome)) {
    return { class: 'authoritative' };
  }
  if (input.code !== undefined && AUTHORITATIVE_OUTCOMES.has(input.code)) {
    return { class: 'authoritative' };
  }
  const account = accountCause(input, text);
  if (account !== null) return { class: 'account', cause: account };
  const resetAt = rateLimitedReset(input, text);
  if (resetAt !== null) return { class: 'rate-limited', resetAt };
  if (isTransient(input, text)) return { class: 'transient' };
  return { class: 'other' };
}

import { type CrewSeatId, CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { HALT_SIGNATURES } from '../../../core/pipeline-spec/halts.js';
import type { RunnerCallWarning } from '../../calls/types.js';

/**
 * Diagnostics a runner emits when its account ran out of usage — plan quota,
 * rate limit, or credit balance. Matched only against failure diagnostics
 * (`RunnerCallResult.error.message` and typed provider error data), never
 * against task output. "Insufficient balance", "payment required", "http 402",
 * "status 402", and '"status":402' are diagnostic-only because the stdout tail
 * carries test logs. Logging out and back in does not fix any of these, so
 * they must never be classified as auth failures.
 *
 * Codex phrases were captured live from `codex exec --json` (2026-08-06):
 * "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
 * to purchase more credits or try again at Aug 8th, 2026 3:27 PM." — a bare-
 * clock variant ends "or try again at 3:27 PM."; the Plus/Pro variant ends
 * "or try again in 5 days 22 hours 11 minutes." instead.
 * Claude Code reports its limits as `is_error` result text: "You've hit your
 * session limit · resets 3:45pm", "You've hit your weekly limit · resets Mon
 * 12:00am", "You've hit your Opus limit · resets 3:45pm", "You've reached
 * your <model> limit. Run /usage-credits to continue or switch models with
 * /model.", "Credit balance is too low", and "API Error: Request rejected
 * (429) ·..."; older versions emitted "Claude AI usage limit reached|<epoch>".
 * API providers surface HTTP 429 bodies: Anthropic `rate_limit_error` ("This
 * request would exceed your account's rate limit."), OpenAI
 * `insufficient_quota` ("You exceeded your current quota, ..."), Groq/
 * OpenRouter/Together "Rate limit ..." prose. OpenCode 1.x error envelopes
 * carry "Rate limit exceeded" with `statusCode: 429`; 2.0.12 emits a flat
 * `{"type":"error","error":{"type":"provider.quota","message":"Go usage limit
 * exceeded","status":429}}` (captured live 2026-09-21). Antigravity (`agy -p`) prints
 * its limit on stderr — "error: Individual quota reached. Please upgrade your
 * subscription to increase your limits. Resets in 2h6m30s." (captured live
 * 2026-09-21) — once beside exit 0 with "(response may be truncated)" appended,
 * then beside exit 3; the Gemini API body behind it says `RESOURCE_EXHAUSTED`.
 * DeepSeek through opencode reports `provider.quota: Insufficient Balance`
 * (captured live 2026-10-05).
 */
const USAGE_LIMIT_STRONG_PATTERNS: readonly RegExp[] = [
  /you'?ve (?:hit|reached) your[^.!\n]{0,40}\blimit\b/,
  /rate.?limit.?\s+(?:reached|exceeded)/,
  /rate_limit_error/,
  /api\s+error.*\b429\b/,
  /request rejected.*\(?\s*429\s*\)?/,
  /insufficient balance/,
  /payment required/,
  /(?:http |status |"status":)402\b/,
  /billing[_ ]hard[_ ]limit/,
  /billing[_ ]not[_ ]active/,
  /requires more credits/,
  /out of credits/,
];

const USAGE_LIMIT_WEAK_429 = /\b429\b/;
const USAGE_LIMIT_WEAK_RATE_LIMIT = /rate.?limit/;

export function hasUsageLimitNounCorroboration(text: string): boolean {
  if (/too many requests/.test(text)) return true;
  if (/retry-after/.test(text)) return true;
  if (/\bquota\b/.test(text)) return true;
  const withoutRateLimitPhrase = text.replace(/rate[- ]?limits?/g, '');
  return /\blimit\b/.test(withoutRateLimitPhrase);
}

export function isUsageLimitDiagnostic(message: string): boolean {
  const text = message.toLowerCase();
  if (HALT_SIGNATURES.usage.some((phrase) => text.includes(phrase))) return true;
  if (USAGE_LIMIT_STRONG_PATTERNS.some((pattern) => pattern.test(text))) return true;
  const weak = USAGE_LIMIT_WEAK_429.test(text) || USAGE_LIMIT_WEAK_RATE_LIMIT.test(text);
  return weak && hasUsageLimitNounCorroboration(text);
}

/**
 * The usage limit a call printed on stderr, when it printed one. A call that
 * produced nothing beside it ran out of quota rather than finishing: antigravity
 * exits 0 with "(response may be truncated)" the first time its quota trips.
 */
export function stderrUsageLimit(warnings: readonly RunnerCallWarning[]): string | undefined {
  return warnings.find(
    (warning) => warning.source === 'stderr' && isUsageLimitDiagnostic(warning.message),
  )?.message;
}

/**
 * What a seat out of quota can do, in the recovery menu's own words: wait for
 * the reset, or change the seat's tool. Never re-authenticating — a login
 * cannot restore quota. The sentence is stored and replayed on other days, so
 * it names no clock: the halt's `resetAt` carries the reset, and every surface
 * spells it when it is read (`formatResetAt`).
 */
export function usageLimitAdvice(input: Readonly<{ tool: string; seat: CrewSeatId }>): string {
  return `${input.tool} hit its usage limit. Wait for the limit to reset or change the ${CREW_SEAT_LABELS[input.seat]} tool, then continue.`;
}

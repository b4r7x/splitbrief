import { isRecord } from '../../utils/type-guards.js';

/**
 * Diagnostics a runner emits when its account ran out of usage — plan quota,
 * rate limit, or credit balance. Matched only against failure diagnostics
 * (`RunnerCallResult.error.message` and typed provider error data), never
 * against task output. Logging out and back in does not fix any of these, so
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
 * OpenRouter/Together "Rate limit ..." prose. OpenCode error envelopes carry
 * "Rate limit exceeded" with `statusCode: 429`.
 */
const USAGE_LIMIT_STRONG_PATTERNS: readonly RegExp[] = [
  /you'?ve (?:hit|reached) your[^.!\n]{0,40}\blimit\b/,
  /usage limit reached/,
  /too many requests/,
  /insufficient_quota/,
  /exceeded your current quota/,
  /credit balance is too low/,
  /rate.?limit.?\s+(?:reached|exceeded)/,
  /rate_limit_error/,
  /api\s+error.*\b429\b/,
  /request rejected.*\(?\s*429\s*\)?/,
];

const USAGE_LIMIT_WEAK_429 = /\b429\b/;
const USAGE_LIMIT_WEAK_RATE_LIMIT = /rate.?limit/;

function hasUsageLimitNounCorroboration(text: string): boolean {
  if (/too many requests/.test(text)) return true;
  if (/retry-after/.test(text)) return true;
  if (/\bquota\b/.test(text)) return true;
  const withoutRateLimitPhrase = text.replace(/rate[- ]?limits?/g, '');
  return /\blimit\b/.test(withoutRateLimitPhrase);
}

export function isUsageLimitDiagnostic(message: string): boolean {
  const text = message.toLowerCase();
  if (USAGE_LIMIT_STRONG_PATTERNS.some((pattern) => pattern.test(text))) return true;
  const weak = USAGE_LIMIT_WEAK_429.test(text) || USAGE_LIMIT_WEAK_RATE_LIMIT.test(text);
  return weak && hasUsageLimitNounCorroboration(text);
}

const ORDINAL_DAY = /(\d{1,2})(?:st|nd|rd|th)/i;
const TRY_AGAIN_AT =
  /try again at ([a-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4},? \d{1,2}:\d{2}\s?(?:am|pm)?)/i;
const TRY_AGAIN_AT_BARE_CLOCK = /try again at (\d{1,2}):(\d{2})\s?(am|pm)/i;
const TRY_AGAIN_IN_SECONDS = /try again in ([\d.]+)\s*s(?:econds?)?\b/i;
const TRY_AGAIN_IN_PARTS =
  /try again in (?:(\d+) days?)?\s*(?:(\d+) hours?)?\s*(?:(\d+) minutes?)?/i;
const RETRY_AFTER_SECONDS = /retry-after: (\d+(?:\.\d+)?)s\b/i;
const LIMIT_EPOCH = /limit reached\|(\d{10,13})\b/i;
const RESETS_AT =
  /resets (?:(sun|mon|tue|wed|thu|fri|sat)[a-z]* )?(\d{1,2})(?::(\d{2}))?\s?(am|pm)/i;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function parseEpoch(text: string): Date | null {
  const match = LIMIT_EPOCH.exec(text);
  if (match?.[1] === undefined) return null;
  const raw = Number.parseInt(match[1], 10);
  return new Date(match[1].length >= 13 ? raw : raw * 1000);
}

function parseTryAgainAt(text: string): Date | null {
  const match = TRY_AGAIN_AT.exec(text);
  if (match?.[1] === undefined) return null;
  const parsed = new Date(match[1].replace(ORDINAL_DAY, '$1'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTryAgainAtBareClock(text: string, now: Date): Date | null {
  const match = TRY_AGAIN_AT_BARE_CLOCK.exec(text);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  let hour = Number.parseInt(match[1], 10) % 12;
  if (match[3].toLowerCase() === 'pm') hour += 12;
  const minute = Number.parseInt(match[2], 10);
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function parseRelative(text: string, now: Date): Date | null {
  const seconds = TRY_AGAIN_IN_SECONDS.exec(text) ?? RETRY_AFTER_SECONDS.exec(text);
  if (seconds?.[1] !== undefined) {
    return new Date(now.getTime() + Math.ceil(Number.parseFloat(seconds[1]) * 1000));
  }
  const parts = TRY_AGAIN_IN_PARTS.exec(text);
  if (!parts || (parts[1] === undefined && parts[2] === undefined && parts[3] === undefined)) {
    return null;
  }
  const days = parts[1] === undefined ? 0 : Number.parseInt(parts[1], 10);
  const hours = parts[2] === undefined ? 0 : Number.parseInt(parts[2], 10);
  const minutes = parts[3] === undefined ? 0 : Number.parseInt(parts[3], 10);
  return new Date(now.getTime() + ((days * 24 + hours) * 60 + minutes) * 60_000);
}

function parseResetsAt(text: string, now: Date): Date | null {
  const match = RESETS_AT.exec(text);
  if (match?.[2] === undefined || match[4] === undefined) return null;
  let hour = Number.parseInt(match[2], 10) % 12;
  if (match[4].toLowerCase() === 'pm') hour += 12;
  const minute = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  const weekday = match[1]?.toLowerCase();
  if (weekday !== undefined) {
    let target = -1;
    for (let i = 0; i < WEEKDAYS.length; i++) {
      if (WEEKDAYS[i] === weekday) {
        target = i;
        break;
      }
    }
    if (target === -1) return null;
    let ahead = (target - candidate.getDay() + 7) % 7;
    if (ahead === 0 && candidate.getTime() <= now.getTime()) ahead = 7;
    candidate.setDate(candidate.getDate() + ahead);
  } else if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * Extract the reset moment a limit diagnostic advertises, when it does:
 * codex "try again at <date>" / "try again at 3:27 PM" / "try again in N days
 * N hours N minutes",
 * Claude Code "resets 3:45pm" / "resets Mon 12:00am" and the legacy
 * "|<epoch>" suffix, Groq "try again in 7.66s", and the "(retry-after: Ns)"
 * suffix this codebase appends from HTTP Retry-After headers. Returns null
 * when the message carries no parseable reset — classification never
 * depends on this.
 */
export function parseUsageLimitReset(message: string, now: Date = new Date()): Date | null {
  return (
    parseEpoch(message) ??
    parseTryAgainAt(message) ??
    parseTryAgainAtBareClock(message, now) ??
    parseRelative(message, now) ??
    parseResetsAt(message, now)
  );
}

export function formatUsageLimitReset(resetsAt: Date): string {
  return resetsAt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The provider's own words for a limit failure that arrived as a thrown typed
 * error instead of a failed call result — the API-runner path. Prefers the
 * nested runner-call error, then the raw HTTP detail (`stream-http-status`
 * keeps it under `data.detail` while its top-level message is a rewritten
 * hint), then the error message. A bare 429 status counts as a limit even
 * when the body text matches no known phrase.
 */
export function usageLimitDetailFromError(err: unknown): string | null {
  if (!isRecord(err)) return null;
  const data = isRecord(err.data) ? err.data : undefined;
  const nested = data !== undefined && isRecord(data.error) ? data.error : undefined;
  const raw = [nested?.message, data?.detail].filter(
    (value): value is string => typeof value === 'string',
  );
  const matched = raw.find((text) => isUsageLimitDiagnostic(text));
  if (matched !== undefined) return matched;
  const status = data?.status ?? data?.statusCode;
  const message = typeof err.message === 'string' ? err.message : undefined;
  if (status === 429) return raw[0] ?? message ?? 'HTTP 429';
  if (message !== undefined && isUsageLimitDiagnostic(message)) return raw[0] ?? message;
  return null;
}

export function usageLimitWaitClause(resetsAt: Date | null): string {
  return resetsAt === null
    ? 'Wait for the limit to reset'
    : `The limit resets at ${formatUsageLimitReset(resetsAt)}; wait for it`;
}

/**
 * What the user can actually do about a limit: wait for the reset (named when
 * the tool said when), switch to a different runner profile, or stop. Never
 * suggests re-authenticating — a login cannot restore quota.
 */
export function usageLimitGuidance(resetsAt: Date | null): string {
  return `${usageLimitWaitClause(resetsAt)}, switch to a different runner profile, or abort.`;
}

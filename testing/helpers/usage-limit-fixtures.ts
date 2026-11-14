// Captured live from `codex exec --json` on 2026-08-06 against an account at
// its usage limit; the same message arrives back-to-back as an `error` record
// and a `turn.failed` record.
export const CODEX_LIMIT_MESSAGE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.";
// The Plus/Pro variant of the same limit (openai/codex#3899).
export const CODEX_LIMIT_RELATIVE =
  "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 5 days 22 hours 11 minutes.";

// Verbatim strings from the Claude Code error reference
// (code.claude.com/docs/en/errors); they arrive as `is_error` result text.
export const CLAUDE_SESSION_LIMIT = "You've hit your session limit · resets 3:45pm";
export const CLAUDE_WEEKLY_LIMIT = "You've hit your weekly limit · resets Mon 12:00am";
export const ANTHROPIC_RATE_LIMIT_BODY =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CcuTLfeewCy8ujAVGd6Ws"}';

export const GROQ_RATE_LIMIT =
  'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` on tokens per minute (TPM). Please try again in 7.66s.';
// Captured live from `agy -p` (antigravity 1.2.7) on 2026-09-21: the line lands
// on stderr, first beside exit 0 with "(response may be truncated)" appended,
// then beside exit 3 on the retry.
export const ANTIGRAVITY_QUOTA =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)';

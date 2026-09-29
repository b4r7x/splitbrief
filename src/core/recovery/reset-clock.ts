/**
 * The reset moment as a clock on the wall: local 24-hour time, plus the date
 * when it is not today — a bare `17:00` would read as this afternoon. One body
 * for every surface that spells it live — the recovery headline, the recovery
 * panel, the workflow header, a halt's error row and its headless line — so one
 * instant is never spelled two ways.
 */
export function formatResetNote(resetAt: number, now: number = Date.now()): string {
  const reset = new Date(resetAt);
  return `resets ${isSameLocalDay(reset, new Date(now)) ? wallClock(reset) : datedClock(reset)}`;
}

/**
 * A record's `resetAt` — the ISO instant a halt or its error row carries — spelled when it is read,
 * so a run reopened on a later day dates it; nothing when the record names no instant.
 */
export function formatResetAt(
  resetAt: string | undefined,
  now: number = Date.now(),
): string | undefined {
  const at = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
  return Number.isFinite(at) ? formatResetNote(at, now) : undefined;
}

/**
 * The reset as stored text spells it — a runner's rate-limit warning: the same
 * clock, always dated, because the transcript replays the text on other days,
 * where a bare clock would name the wrong one.
 */
export function formatStoredReset(resetAt: number): string {
  return datedClock(new Date(resetAt));
}

function wallClock(reset: Date): string {
  return reset.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function datedClock(reset: Date): string {
  return `${reset.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${wallClock(reset)}`;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

// One instant, one spelling: whichever surface carries the reset clock, the others drop the clause
// rather than restating it in their own words — Claude Code's "· resets 3:45pm", the "or try again
// at …" that ends codex's limit sentence (a period before a digit is a decimal, not its end), and
// antigravity's "Resets in 2h6m30s." when it is a sentence of its own.
const RESET_CLAUSES = [
  /\s*·\s*resets\b[^·]*$/iu,
  /\s+or try again (?:at|in) (?:[^.]|\.(?=\d))*(?=\.?\s*$)/iu,
  /(?<=[.!?])\s+resets in (?:\d+h)?(?:\d+m)?(?:\d+s)?(?![\w:])\.?/iu,
] as const;

export function stripRecoveryResetClause(text: string): string {
  return RESET_CLAUSES.reduce((stripped, clause) => stripped.replace(clause, ''), text);
}

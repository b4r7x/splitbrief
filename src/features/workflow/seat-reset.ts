/**
 * The reset moment as the header and the recovery panel both say it: the
 * operator is waiting for a clock on the wall, so it is the local 24-hour time
 * and nothing else. A reset that is not today carries its date too — a bare
 * `17:00` would read as this afternoon — and the date is spelled the way every
 * other date in the app is.
 */
export function formatSeatResetNote(resetAt: number, now: number = Date.now()): string {
  const reset = new Date(resetAt);
  const clock = reset.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (isSameLocalDay(reset, new Date(now))) return `resets ${clock}`;
  const day = reset.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `resets ${day}, ${clock}`;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

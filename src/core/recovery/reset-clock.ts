/**
 * The reset moment as a clock on the wall: local 24-hour time, plus the date
 * when it is not today — a bare `17:00` would read as this afternoon. One body
 * for every surface that spells it — the recovery headline, the recovery panel
 * and the workflow header — so one instant is never spelled two ways.
 */
export function formatResetNote(resetAt: number, now: number = Date.now()): string {
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

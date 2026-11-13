/** `3.0s` under a minute; from a minute on, whole units (`46m 54s`), since `2814.2s` reads as a number. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '0.0s';
  const tenths = Math.round(Math.max(0, ms) / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  return formatTime(Math.round(ms / 1000) * 1000);
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return '0s';
  const totalSecs = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/** A running step's clock: `m:ss`, or `h:mm:ss` once it passes an hour. */
export function formatElapsedClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${minutes}:${seconds}`;
}

/** An instant as a clock on the wall: local 24-hour time, plus the date when it is not today. */
export function formatWallClock(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  return isSameLocalDay(date, new Date(now)) ? hourMinute(date) : formatDatedClock(at);
}

/** An instant as a dated clock on the wall: `Oct 27, 11:53`. */
export function formatDatedClock(at: number): string {
  const date = new Date(at);
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${hourMinute(date)}`;
}

function hourMinute(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

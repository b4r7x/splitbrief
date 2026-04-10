export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatCost(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

export function formatTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function truncate(str: string, max: number): string {
  if (max <= 0) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type SemVer = [number, number, number];

export function parseVersion(raw: string): SemVer | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function warnStderr(message: string): void {
  process.stderr.write(`\x1b[2m${message}\x1b[0m\n`);
}

export function warnError(context: string, err: unknown): void {
  warnStderr(`${context}: ${toErrorMessage(err)}`);
}

export function formatTimeHHMMSS(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSecs / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
  const s = String(totalSecs % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSecs = Math.floor(diffMs / 1000);

  if (diffSecs < 60) return 'just now';

  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

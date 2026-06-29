export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '0.0s';
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
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

export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return `~${formatTime(ms)} remaining`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

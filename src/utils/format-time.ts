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

export function formatTimeHHMMSS(ms: number): string {
  if (!Number.isFinite(ms)) return '00:00:00';
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSecs / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
  const s = String(totalSecs % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return `~${formatTime(ms)} remaining`;
}

import { redactSecrets } from './redact.js';

export function formatContextLength(tokens: number | undefined): string {
  if (tokens == null || tokens === 0) return '';
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '0.0s';
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function formatCost(dollars: number): string {
  if (!Number.isFinite(dollars)) return '$0.00';
  return `$${Math.max(0, dollars).toFixed(2)}`;
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

export function truncate(str: string, max: number): string {
  if (max <= 0) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}

export function toErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

export const labelError = (action: string, err: unknown): string =>
  `${action}: ${toErrorMessage(err)}`;

type SemVer = [number, number, number];

export function parseVersion(raw: string): SemVer | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
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

export function formatRelativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'just now';
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

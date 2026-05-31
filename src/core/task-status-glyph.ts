import type { TaskStatus } from './schemas/enums.js';

export const STATUS_GLYPH: Record<TaskStatus, string> = {
  done: '✓',
  failed: '✗',
  escalated: '⚠',
  in_progress: '◉',
  pending: '○',
  skipped: '○',
};

export function statusGlyph(status: TaskStatus): string {
  return STATUS_GLYPH[status];
}

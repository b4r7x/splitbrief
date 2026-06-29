import type { TaskStatus } from '../core/schemas/enums.js';
import { glyph, type GlyphName } from '../lib/glyphs.js';

const STATUS_GLYPH_NAME: Record<TaskStatus, GlyphName> = {
  done: 'statusDone',
  failed: 'statusFailed',
  escalated: 'statusEscalated',
  in_progress: 'statusInProgress',
  pending: 'statusPending',
  skipped: 'statusSkipped',
};

export function statusGlyph(status: TaskStatus): string {
  return glyph(STATUS_GLYPH_NAME[status]);
}

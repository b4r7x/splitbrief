import { glyph } from '../../lib/glyphs.js';

export type ListRowState = 'default' | 'active' | 'context';

const LEAD_BLANK = '  ';

export function listRowLead(state: ListRowState): string {
  return state === 'active' || state === 'context' ? `${glyph('liveBar')} ` : LEAD_BLANK;
}

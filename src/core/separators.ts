import { glyph } from '../lib/glyphs.js';

/** The one middle dot that joins the parts of a run: `local · 2 retries · 1.4s`. */
export const SOFT_SEP = ' · ';

export function arrowSep(): string {
  return ` ${glyph('connectorHandoff')} `;
}

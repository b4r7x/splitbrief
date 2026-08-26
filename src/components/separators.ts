import { glyph } from '../lib/glyphs.js';

export const SOFT_SEP = ' · ';

export function arrowSep(): string {
  return ` ${glyph('connectorHandoff')} `;
}

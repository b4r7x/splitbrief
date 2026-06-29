import { glyph } from '../../lib/glyphs.js';

export const NO_CURSOR = '  ';

export function cursorGlyph(): string {
  return `${glyph('cursor')} `;
}

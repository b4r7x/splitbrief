import { beforeAll, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { FALLBACK_NONE_WORDS, type FallbackRow } from '../../core/crew/fallback.js';
import { CREW_SEAT_LABELS, PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { glyph } from '../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { CREW_IDENTITY_COLUMN, CREW_MARKER_GUTTER } from './format.js';
import { FallbackRowView } from './fallback-row-view.js';

async function rowLines(row: FallbackRow, width: number, isCursor = false): Promise<string[]> {
  const ui = renderFeature(<FallbackRowView row={row} width={width} isCursor={isCursor} />, {
    cols: 120,
    rows: 40,
  });
  await flushEffects();
  const lines = stripAnsiStyles(ui.lastFrame())
    .split('\n')
    .filter((line) => line.trim() !== '');
  ui.unmount();
  return lines;
}

describe('FallbackRowView', () => {
  beforeAll(forceUnicodeGlyphs);

  it('aligns the cursor, seat label and None words with the crew columns on one line', async () => {
    const lines = await rowLines({ id: 'build', inherited: false }, 60, true);
    const line = lines[0] ?? '';

    expect(lines).toHaveLength(1);
    expect(line.startsWith(`${glyph('liveBar')} `)).toBe(true);
    expect(line.indexOf(CREW_SEAT_LABELS.build)).toBe(CREW_MARKER_GUTTER);
    expect(line.indexOf(FALLBACK_NONE_WORDS)).toBe(CREW_IDENTITY_COLUMN);
  });

  it('marks inheritance when PLAN sets no fallback', async () => {
    const lines = await rowLines({ id: 'review', inherited: true }, 60);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${PLANNER_INHERITANCE.mark} · ${FALLBACK_NONE_WORDS}`);
  });

  it.each([48, 60, 78])(
    'keeps the warning whole when the identity is cut at %i columns',
    async (width) => {
      const lines = await rowLines(
        {
          id: 'build',
          fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
          identity: 'Codex CLI · GPT-5 Codex · high',
          inherited: false,
          note: 'not installed',
        },
        width,
      );

      expect(lines).toHaveLength(1);
      expect(lines[0]?.trimEnd()).toMatch(/ · not installed$/);
      expect(getTerminalCellWidth(lines[0] ?? '')).toBeLessThanOrEqual(width);
    },
  );
});

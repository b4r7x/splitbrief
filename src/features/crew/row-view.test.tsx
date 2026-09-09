import { Box } from 'ink';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import {
  CREW_LABEL_WIDTH,
  CREW_SEAT_LABELS,
  PLANNER_INHERITANCE,
} from '../../core/crew/identity.js';
import { crewRowKey, deriveCrewRows, type CrewRowKey } from '../../core/crew/rows.js';
import type { Config } from '../../core/schemas/config.js';
import { glyph, type GlyphName } from '../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { CREW_IDENTITY_COLUMN, CREW_MARKER_GUTTER, planSeatBlock } from './format.js';
import { CrewRowView, CrewVerdictLine } from './row-view.js';

/** The label column starts here: cursor gutter (2). */
const LABEL_COLUMN = CREW_MARKER_GUTTER;

type BlockProps = Readonly<{ config: Config; width: number; cursor?: CrewRowKey }>;

function CrewBlock({ config, width, cursor }: BlockProps) {
  const rows = deriveCrewRows({ config });
  const layout = planSeatBlock({ rows, verdict: undefined, innerWidth: width, rowBudget: 20 });

  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <CrewRowView
          key={crewRowKey(row)}
          row={row}
          layout={layout}
          isCursor={crewRowKey(row) === cursor}
          width={width}
        />
      ))}
    </Box>
  );
}

async function linesFor(props: BlockProps): Promise<string[]> {
  const ui = renderFeature(<CrewBlock {...props} />, { cols: 120, rows: 40 });
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame.split('\n').filter((line) => line.trim() !== '');
}

async function firstLineOf(node: ReactElement): Promise<string> {
  const ui = renderFeature(node, { cols: 120, rows: 40 });
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame.split('\n')[0] ?? '';
}

function lineWith(lines: readonly string[], token: string): string {
  const found = lines.find((line) => line.includes(token));
  if (found === undefined) throw new Error(`No rendered row contains ${token}.`);
  return found;
}

describe('crew row view', () => {
  beforeAll(forceUnicodeGlyphs);

  it('ends every posture word on one column across the block', async () => {
    const lines = await linesFor({ config: makeConfig(), width: 78 });

    for (const label of Object.values(CREW_SEAT_LABELS)) {
      // Width 78: identity column 12 + identity 52 + gap 2 + posture 12 = the row edge.
      expect(getTerminalCellWidth(lineWith(lines, label).trimEnd())).toBe(78);
    }
  });

  it('drops the posture column for the whole block when the identity would not survive', async () => {
    const config = makeConfig();
    const wide = await linesFor({ config, width: 78 });
    const posture = lineWith(wide, CREW_SEAT_LABELS.plan).trim().split(/\s+/).at(-1) ?? '';
    expect(posture).not.toBe('');

    const narrow = await linesFor({ config, width: 50 });

    for (const label of Object.values(CREW_SEAT_LABELS)) {
      expect(lineWith(narrow, label)).not.toContain(posture);
      expect(getTerminalCellWidth(lineWith(narrow, label).trimEnd())).toBeLessThan(50);
    }
  });

  it('marks only the cursor row in its gutter', async () => {
    const config = makeConfig();
    const cursored = lineWith(
      await linesFor({ config, width: 78, cursor: 'seat:plan' }),
      CREW_SEAT_LABELS.plan,
    );
    const plain = lineWith(await linesFor({ config, width: 78 }), CREW_SEAT_LABELS.plan);

    expect(plain.startsWith('  ')).toBe(true);
    expect(cursored.startsWith('  ')).toBe(false);
    expect(cursored.trimStart()).not.toBe(plain.trimStart());
  });

  it('spells the inherited review seat with the mark and the planner it follows', async () => {
    const config = makeConfig();
    const lines = await linesFor({ config, width: 78 });
    const review = lineWith(lines, CREW_SEAT_LABELS.review);
    const reviewRow = deriveCrewRows({ config }).find((row) => row.id === 'review');
    if (reviewRow === undefined) throw new Error('no review seat');

    expect(review).toContain(PLANNER_INHERITANCE.mark);
    expect(review).toContain(reviewRow.seat.model);
  });

  it('gives every row a word in the label column, never a glyph alone', async () => {
    const lines = await linesFor({ config: makeConfig(), width: 78 });

    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(line.slice(LABEL_COLUMN, LABEL_COLUMN + CREW_LABEL_WIDTH).trim()).not.toBe('');
    }
  });

  it('renders no tree or connector glyphs when there is no cursor row', async () => {
    const lines = await linesFor({ config: makeConfig(), width: 78 });
    const frame = lines.join('\n');
    const glyphNames: readonly GlyphName[] = ['stageDone', 'treeBranch', 'treeLast', 'treeMid'];
    const tiers = ['unicode', 'ascii'] as const;

    for (const name of glyphNames) {
      for (const tier of tiers) {
        expect(frame).not.toContain(glyph(name, tier));
      }
    }
  });

  it('hangs the verdict line off the identity column', async () => {
    const verdict = await firstLineOf(<CrewVerdictLine verdict="cross-lab" width={78} />);

    expect(getTerminalCellWidth(verdict.trimEnd())).toBeLessThanOrEqual(78);
    expect(verdict.search(/\S/)).toBe(CREW_IDENTITY_COLUMN);
    expect(verdict.trim().split(/\s+/).length).toBeGreaterThan(1);
  });
});

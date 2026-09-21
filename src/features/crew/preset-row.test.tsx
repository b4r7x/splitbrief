import { describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { PresetRowView } from './preset-row.js';

const DESCRIPTION = 'Claude Code plans and builds; Codex reviews the diff from another lab.';

const PRESET: CrewPreset = {
  id: 'claude-crew-codex-review',
  label: 'Claude crew, Codex review',
  description: DESCRIPTION,
  seats: {
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: { kind: 'cli', tool: 'opencode' },
    reviewer: { kind: 'cli', tool: 'codex' },
  },
};

async function lineFor(width: number, cols: number, isCursor = true): Promise<string> {
  const ui = renderFeature(
    <PresetRowView
      preset={PRESET}
      isCursor={isCursor}
      width={width}
      labelWidth={getTerminalCellWidth(PRESET.label)}
    />,
    { cols, rows: 24 },
  );
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame.split('\n')[0] ?? '';
}

describe('crew preset row', () => {
  it('renders the whole description when the panel has room for it', async () => {
    // Setup at 120x40: inner 102 − label column 2 − label 25 − gap 2 = 73 cells for 70 characters.
    expect(getTerminalCellWidth(DESCRIPTION)).toBe(70);

    const line = await lineFor(102, 120);

    expect(line).toContain(PRESET.label);
    expect(line).toContain(DESCRIPTION);
  });

  it('keeps the row inside the width it is given', async () => {
    const line = await lineFor(50, 60);

    expect(getTerminalCellWidth(line.trimEnd())).toBeLessThanOrEqual(50);
    expect(line).toContain('Claude Code plans');
  });

  it('marks the row under the cursor and leaves the others blank in that gutter', async () => {
    const cursored = await lineFor(102, 120);
    const plain = await lineFor(102, 120, false);

    expect(plain.startsWith('  ')).toBe(true);
    expect(cursored.startsWith('  ')).toBe(false);
    expect(getTerminalCellWidth(cursored)).toBe(getTerminalCellWidth(plain));
    // The marker gutter is the first 2 cells; everything after it is identical on both rows.
    expect(cursored.slice(2)).toBe(plain.slice(2));
  });
});

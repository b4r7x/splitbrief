import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { listRowLead } from '../../components/list-row.js';
import { defaultTheme, ThemeProvider } from '../../components/theme.js';
import { paint } from '../../core/theme/paint.js';
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
  notReady: [],
};

async function frameFor(
  width: number,
  cols: number,
  isCursor = true,
  preset: CrewPreset = PRESET,
): Promise<string> {
  const ui = renderFeature(
    <PresetRowView
      preset={preset}
      isCursor={isCursor}
      width={width}
      labelWidth={getTerminalCellWidth(PRESET.label)}
    />,
    { cols, rows: 24 },
  );
  await flushEffects();
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  return frame;
}

async function lineFor(width: number, cols: number, isCursor = true): Promise<string> {
  return stripAnsiStyles(await frameFor(width, cols, isCursor)).split('\n')[0] ?? '';
}

async function themedFrameFor(isCursor: boolean): Promise<string> {
  const ui = renderFeature(
    <ThemeProvider theme={{ ...defaultTheme, accent: 'red' }}>
      <PresetRowView
        preset={PRESET}
        isCursor={isCursor}
        width={102}
        labelWidth={getTerminalCellWidth(PRESET.label)}
      />
    </ThemeProvider>,
    { cols: 120, rows: 24 },
  );
  await flushEffects();
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  return frame;
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

  it('leads the gutter with the shared list marker and never a dot', async () => {
    const cursored = await lineFor(102, 120);
    const plain = await lineFor(102, 120, false);

    expect(cursored.startsWith(listRowLead('active'))).toBe(true);
    expect(plain.startsWith(listRowLead('default'))).toBe(true);
    expect(cursored).not.toContain('·');
    expect(plain).not.toContain('·');
  });

  it('names the tools an unavailable crew needs in place of its description', async () => {
    const frame = await frameFor(102, 120, true, { ...PRESET, notReady: ['claude-code', 'codex'] });
    const line = stripAnsiStyles(frame).split('\n')[0] ?? '';

    expect(line).toContain(
      `${PRESET.label}  Unavailable · needs Claude Code CLI, OpenAI Codex CLI`,
    );
    expect(line).not.toContain(DESCRIPTION);
  });

  it('keeps the gutter and whole words when the label column fills a narrow row', async () => {
    const width = getTerminalCellWidth(PRESET.label) + 3;
    for (const notReady of [[], ['opencode']] as const) {
      const line =
        stripAnsiStyles(await frameFor(width, 40, true, { ...PRESET, notReady })).split('\n')[0] ??
        '';

      expect(line.trimEnd()).toBe(`${listRowLead('active')}${PRESET.label}`);
    }
  });

  it('paints the label accent only under the highlight', async () => {
    const originalLevel = chalk.level;
    chalk.level = 1;
    try {
      const cursored = await themedFrameFor(true);
      const plain = await themedFrameFor(false);

      expect(cursored).toContain(`\u001B[31m${listRowLead('active')}\u001B[1m${PRESET.label}`);
      expect(plain).toContain(
        `\u001B[31m${listRowLead('default')}${paint(defaultTheme.text, PRESET.label).replace('\u001B[39m', '')}`,
      );
    } finally {
      chalk.level = originalLevel;
    }
  });
});

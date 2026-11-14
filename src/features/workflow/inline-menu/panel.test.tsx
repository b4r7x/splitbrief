import chalk from 'chalk';
import { Box, Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { defaultTheme } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { MenuRows } from '../stop/menu-rows.js';
import { stopSheetRows } from '../stop/options.js';
import { inlineMenuLayout } from './layout.js';
import { InlineMenuPanel } from './panel.js';

const originalColorLevel = chalk.level;

function openCode(paintText: (text: string) => string): string {
  return paintText('x').split('x')[0] ?? '';
}

function rows(frame: string | undefined): string[] {
  return stripAnsiStyles(frame ?? '').split('\n');
}

describe('InlineMenuPanel', () => {
  afterEach(() => {
    chalk.level = originalColorLevel;
  });

  it('frames a focused menu in the accent colour, title first and legend last', () => {
    chalk.level = 3;
    const ui = renderFeature(
      <InlineMenuPanel width={30} height={5} framed focused title="Stop options" legend="↑↓ select">
        <Text>Stop now</Text>
      </InlineMenuPanel>,
    );

    expect(ui.lastFrame()?.startsWith(openCode((text) => paint(defaultTheme.accent, text)))).toBe(
      true,
    );
    expect(rows(ui.lastFrame()).map((row) => row.slice(2, -2).trimEnd())).toEqual([
      expect.anything(),
      'Stop options',
      'Stop now',
      '↑↓ select',
      expect.anything(),
    ]);
    ui.unmount();
  });

  it('dims the frame while the composer holds the keys', () => {
    chalk.level = 3;
    const ui = renderFeature(
      <InlineMenuPanel width={30} height={5} framed focused={false} legend="tab back">
        <Text>Apply</Text>
      </InlineMenuPanel>,
    );

    expect(
      ui
        .lastFrame()
        ?.startsWith(
          `${openCode((text) => chalk.dim(text))}${openCode((text) => paint(defaultTheme.border, text))}`,
        ),
    ).toBe(true);
    ui.unmount();
  });

  it('paints exactly its height, the legend right under the rows and the spare rows below it', () => {
    const ui = renderFeature(
      <InlineMenuPanel width={30} height={8} framed focused title="Ready" legend="↑↓ select">
        <Text>Apply</Text>
      </InlineMenuPanel>,
    );
    const lines = rows(ui.lastFrame());

    expect(lines).toHaveLength(8);
    expect(lines.map(getTerminalCellWidth)).toEqual(Array(8).fill(30));
    expect(lines.slice(1, -1).map((row) => row.slice(2, -2).trim())).toEqual([
      'Ready',
      'Apply',
      '↑↓ select',
      '',
      '',
      '',
    ]);
    ui.unmount();
  });

  it('drops the border and starts each row on the composer text column when unframed', () => {
    const ui = renderFeature(
      <InlineMenuPanel width={30} height={2} framed={false} focused>
        <Text>Stop now</Text>
        <Text>End run</Text>
      </InlineMenuPanel>,
    );

    expect(rows(ui.lastFrame()).map((row) => row.trimEnd())).toEqual(['  Stop now', '  End run']);
    ui.unmount();
  });

  it('keeps a wrapped consequence inside the frame, hung under its label', () => {
    const layout = inlineMenuLayout(
      stopSheetRows({
        currentTaskId: 'T002',
        nextTaskId: 'T003',
        boundaryPauseRequested: false,
        hasChanges: true,
      }),
      60,
    );
    const ui = renderFeature(
      <InlineMenuPanel
        width={layout.width}
        height={layout.height}
        framed
        focused
        title="Stop options"
        legend="↑↓ select"
      >
        <Box height={layout.bodyRows} flexDirection="column" flexShrink={0}>
          <MenuRows
            options={layout.options}
            selectedIndex={0}
            marked
            rowBudget={layout.bodyRows}
            width={layout.width - 4}
          />
        </Box>
      </InlineMenuPanel>,
      { cols: 60, rows: 24 },
    );
    const lines = rows(ui.lastFrame());
    const inner = lines.slice(1, -1).map((row) => row.slice(2, -2).trimEnd());

    expect(layout.options.some((option) => option.lines.length > 1)).toBe(true);
    expect(lines).toHaveLength(layout.height);
    expect(lines.map(getTerminalCellWidth)).toEqual(Array(layout.height).fill(layout.width));
    expect(inner[0]).toBe('Stop options');
    expect(inner.at(-1)).toBe('↑↓ select');
    expect(inner.slice(1, -1).map((row) => row.slice(2))).toEqual(
      layout.options.flatMap((option) => option.lines.map((line) => line.trimEnd())),
    );
    ui.unmount();
  });

  it('drops the trailing keys of a legend wider than the frame', () => {
    const ui = renderFeature(
      <InlineMenuPanel
        width={24}
        height={4}
        framed
        focused
        legend="↑↓ select · ⏎ confirm · tab close"
      >
        <Text>Stop now</Text>
      </InlineMenuPanel>,
    );
    const inner = rows(ui.lastFrame()).map((row) => row.slice(2, -2).trimEnd());

    expect(inner).toHaveLength(4);
    expect(inner[1]).toBe('Stop now');
    expect(inner[2]).toBe('↑↓ select');
    ui.unmount();
  });
});

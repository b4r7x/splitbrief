import { beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { glyph } from '../../lib/glyphs.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { ListRow } from '../list-row.js';
import { getTheme, ThemeProvider } from '../theme.js';
import { SingleColumnPicker } from './single-column.js';

beforeEach(() => {
  _resetMouseZones();
});

describe('SingleColumnPicker row zones', () => {
  it('registers scrolled visible rows, activates with global indices, and clears zones when onRowActivate is removed', async () => {
    const activated: number[] = [];
    const items = Array.from({ length: 6 }, (_, i) => `item-${i}`);
    const ui = renderFeature(
      <SingleColumnPicker
        label="items"
        items={items}
        filter=""
        selectedIndex={5}
        isActive
        height={6}
        visibleRows={2}
        getKey={(item) => item}
        contentMaxWidth={20}
        rowZonePrefix="sc"
        onRowActivate={(index) => activated.push(index)}
        renderRow={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    const zones = collectClickableZones({ cols: 60, rows: 40 });
    expect(new Set(zones.keys())).toEqual(new Set(['sc:item-4', 'sc:item-5']));

    zones.get('sc:item-4')?.();
    zones.get('sc:item-5')?.();
    expect(activated).toEqual([4, 5]);

    ui.rerender(
      <SingleColumnPicker
        label="items"
        items={items}
        filter=""
        selectedIndex={5}
        isActive
        height={6}
        visibleRows={2}
        getKey={(item) => item}
        contentMaxWidth={20}
        rowZonePrefix="sc"
        renderRow={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    expect(collectClickableZones({ cols: 60, rows: 40 }).size).toBe(0);
    ui.unmount();
  });

  it('clears registered zones when the row budget reaches zero', async () => {
    const items = Array.from({ length: 6 }, (_, i) => `item-${i}`);
    const onRowActivate = () => undefined;
    const ui = renderFeature(
      <SingleColumnPicker
        label="items"
        items={items}
        filter=""
        selectedIndex={5}
        isActive
        height={6}
        visibleRows={2}
        getKey={(item) => item}
        contentMaxWidth={20}
        rowZonePrefix="sc"
        onRowActivate={onRowActivate}
        renderRow={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    expect(collectClickableZones({ cols: 60, rows: 40 }).size).toBe(2);

    ui.rerender(
      <SingleColumnPicker
        label="items"
        items={items}
        filter=""
        selectedIndex={5}
        isActive
        height={6}
        visibleRows={0}
        getKey={(item) => item}
        contentMaxWidth={20}
        rowZonePrefix="sc"
        onRowActivate={onRowActivate}
        renderRow={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    expect(collectClickableZones({ cols: 60, rows: 40 }).size).toBe(0);
    ui.unmount();
  });

  it('keeps row content at the same width with and without overflow', async () => {
    async function metadataEndColumn(visibleRows: number): Promise<number> {
      const ui = renderFeature(
        <SingleColumnPicker
          label="Models"
          items={['one', 'two', 'three']}
          filter=""
          selectedIndex={0}
          isActive
          height={6}
          visibleRows={visibleRows}
          getKey={(item) => item}
          contentMaxWidth={17}
          renderRow={(item, isCursor, maxWidth) => (
            <ListRow
              label={item}
              metadata="1.0M"
              state={isCursor ? 'active' : 'default'}
              width={maxWidth}
            />
          )}
        />,
      );
      await tick();

      const line = stripAnsiStyles(ui.lastFrame() ?? '')
        .split('\n')
        .find((candidate) => candidate.includes('1.0M'));
      ui.unmount();
      expect(line).toBeDefined();
      const upToMetadata = (line ?? '').slice(0, (line ?? '').indexOf('1.0M') + '1.0M'.length);
      return getTerminalCellWidth(upToMetadata);
    }

    const withScrollbar = await metadataEndColumn(2);
    const withoutScrollbar = await metadataEndColumn(3);

    expect(withScrollbar).toBe(withoutScrollbar);
  });

  function listWindow(frame: string, visibleRows: number): string[] {
    const lines = stripAnsiStyles(frame).split('\n');
    const filterRow = lines.findIndex((line) => line.includes('Type to filter'));
    return lines.slice(filterRow + 1, filterRow + 1 + visibleRows);
  }

  const gutterTrackEdge = `${glyph('scrollTrack')} ${glyph('scrollTrack')}`;

  async function renderColumn(
    items: string[],
    visibleRows: number,
    extra?: { rowZonePrefix?: string },
  ) {
    const ui = renderFeature(
      <SingleColumnPicker
        label="Items"
        items={items}
        filter=""
        selectedIndex={0}
        isActive
        height={visibleRows + 4}
        visibleRows={visibleRows}
        getKey={(item) => item}
        contentMaxWidth={18}
        rowZonePrefix={extra?.rowZonePrefix}
        onRowActivate={extra?.rowZonePrefix === undefined ? undefined : () => undefined}
        renderRow={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();
    return ui;
  }

  it('draws no track when items fit the window and keeps row width identical to overflow', async () => {
    const visibleRows = 5;
    const fitting = await renderColumn(['one', 'two'], visibleRows);
    const overflowing = await renderColumn(
      Array.from({ length: 8 }, (_, index) => `item-${index}`),
      visibleRows,
    );

    const fitRows = listWindow(fitting.lastFrame() ?? '', visibleRows);
    const overflowRows = listWindow(overflowing.lastFrame() ?? '', visibleRows);

    expect(fitRows).toHaveLength(visibleRows);
    expect(overflowRows).toHaveLength(visibleRows);
    expect(
      fitRows.every((line) => !line.endsWith(gutterTrackEdge)),
      JSON.stringify(fitRows),
    ).toBe(true);
    expect(fitRows.map(getTerminalCellWidth)).toEqual(overflowRows.map(getTerminalCellWidth));

    fitting.unmount();
    overflowing.unmount();
  });

  it('draws track and thumb when items overflow the window', async () => {
    const ui = await renderColumn(
      Array.from({ length: 8 }, (_, index) => `item-${index}`),
      3,
    );
    const frame = ui.lastFrame() ?? '';
    const rows = listWindow(frame, 3);

    expect(frame).toContain(glyph('scrollThumb'));
    expect(frame).toContain(glyph('scrollTrack'));
    expect(
      rows.some((line) => line.endsWith(gutterTrackEdge) || line.includes(glyph('scrollThumb'))),
      JSON.stringify(rows),
    ).toBe(true);
    ui.unmount();
  });

  it('fills every list-window row while keeping filler rows non-clickable', async () => {
    const ui = await renderColumn(['one', 'two'], 5, { rowZonePrefix: 'fixed-window' });
    const listRows = listWindow(ui.lastFrame() ?? '', 5);

    expect(listRows).toHaveLength(5);
    expect(
      listRows.every((line) => !line.endsWith(gutterTrackEdge)),
      JSON.stringify(listRows),
    ).toBe(true);
    expect(collectClickableZones({ cols: 100, rows: 24 }).size).toBe(2);
    ui.unmount();
  });

  it('renders an overflow thumb with the muted scrollbar color, not the accent color', async () => {
    const originalColorLevel = chalk.level;
    chalk.level = 1;
    const theme = { ...getTheme(), accent: 'red', scrollIndicator: 'green' };
    const ui = renderFeature(
      <ThemeProvider theme={theme}>
        <SingleColumnPicker
          label="Items"
          items={Array.from({ length: 8 }, (_, index) => `item-${index}`)}
          filter=""
          selectedIndex={0}
          isActive
          height={7}
          visibleRows={3}
          getKey={(item) => item}
          contentMaxWidth={18}
          renderRow={(item) => <Text>{item}</Text>}
        />
      </ThemeProvider>,
    );
    await tick();

    try {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain(`\u001B[32m${glyph('scrollThumb')}\u001B[39m`);
      expect(frame).not.toContain(`\u001B[31m${glyph('scrollThumb')}\u001B[39m`);
    } finally {
      ui.unmount();
      chalk.level = originalColorLevel;
    }
  });
});

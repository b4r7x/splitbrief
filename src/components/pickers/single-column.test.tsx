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

  it('fills every list-window row with a track while keeping filler rows non-clickable', async () => {
    const ui = renderFeature(
      <SingleColumnPicker
        label="Items"
        items={['one', 'two']}
        filter=""
        selectedIndex={0}
        isActive
        height={9}
        visibleRows={5}
        getKey={(item) => item}
        contentMaxWidth={18}
        rowZonePrefix="fixed-window"
        onRowActivate={() => undefined}
        renderRow={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const filterRow = lines.findIndex((line) => line.includes('Type to filter'));
    const listRows = lines.slice(filterRow + 1, -1);
    const trackAtRightEdge = `${glyph('scrollTrack')} ${glyph('scrollTrack')}`;

    expect(listRows).toHaveLength(5);
    expect(
      listRows.every((line) => line.endsWith(trackAtRightEdge)),
      JSON.stringify(listRows),
    ).toBe(true);
    expect(collectClickableZones({ cols: 100, rows: 24 }).size).toBe(2);
    ui.unmount();
  });

  it('renders an overflow thumb with the muted scrollbar color, not the accent color', async () => {
    const originalColorLevel = chalk.level;
    chalk.level = 1;
    const theme = { ...getTheme('terminal'), accent: 'red', scrollIndicator: 'green' };
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

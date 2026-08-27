import { beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { ListRow } from '../list-row.js';
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

  it('reserves a 2-cell scrollbar gutter so metadata keeps its last character', async () => {
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

    expect(withoutScrollbar - withScrollbar).toBe(2);
  });
});

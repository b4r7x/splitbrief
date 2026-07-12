import { beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { ListRow } from '../list-row.js';
import { SingleColumnPicker } from './single-column.js';

beforeEach(() => {
  _resetMouseZones();
});

describe('SingleColumnPicker row zones', () => {
  it('registers one clickable zone per visible row firing onRowActivate with the global index', async () => {
    const activated: number[] = [];
    const ui = renderFeature(
      <SingleColumnPicker
        label="items"
        items={['a', 'b', 'c']}
        filter=""
        selectedIndex={0}
        isActive
        height={8}
        visibleRows={5}
        getKey={(item) => item}
        contentMaxWidth={20}
        rowZonePrefix="sc"
        onRowActivate={(index) => activated.push(index)}
        renderRow={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    const zones = collectClickableZones({ cols: 60, rows: 40 });
    zones.get('sc:a')?.();
    zones.get('sc:b')?.();
    zones.get('sc:c')?.();

    expect(activated).toEqual([0, 1, 2]);
    ui.unmount();
  });

  it('registers zones only for the scrolled visible window (global index = scrollOffset + i)', async () => {
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
    expect(zones.has('sc:item-0')).toBe(false);
    expect(zones.has('sc:item-4')).toBe(true);
    expect(zones.has('sc:item-5')).toBe(true);

    zones.get('sc:item-4')?.();
    zones.get('sc:item-5')?.();
    expect(activated).toEqual([4, 5]);
    ui.unmount();
  });

  it('registers no zones without onRowActivate', async () => {
    const ui = renderFeature(
      <SingleColumnPicker
        label="items"
        items={['a', 'b']}
        filter=""
        selectedIndex={0}
        isActive
        height={6}
        visibleRows={5}
        getKey={(item) => item}
        contentMaxWidth={20}
        renderRow={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    expect(collectClickableZones({ cols: 60, rows: 40 }).size).toBe(0);
    ui.unmount();
  });

  it('reserves a 2-cell scrollbar gutter so metadata keeps its last character', async () => {
    const ui = renderFeature(
      <SingleColumnPicker
        label="Models"
        items={['one', 'two', 'three']}
        filter=""
        selectedIndex={0}
        isActive
        height={6}
        visibleRows={2}
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

    expect(ui.lastFrame() ?? '').toContain('1.0M');
    ui.unmount();
  });
});

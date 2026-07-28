import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { _resetMouseZones, hitTopmostZone } from '../../lib/terminal/mouse-zones.js';
import { ListViewport } from './list-viewport.js';
import { RowZone } from './row-zone.js';
import { rowZoneRect } from './row-zone.js';

beforeEach(() => {
  _resetMouseZones();
});

describe('rowZoneRect', () => {
  it('converts a height-1 SGR rect into an inclusive zone box', () => {
    expect(rowZoneRect({ top: 10, left: 5, width: 20, height: 1 })).toEqual({
      top: 10,
      bottom: 10,
      left: 5,
      right: 24,
    });
  });

  it('spans the full height for a multi-line row', () => {
    expect(rowZoneRect({ top: 10, left: 5, width: 20, height: 3 })).toEqual({
      top: 10,
      bottom: 12,
      left: 5,
      right: 24,
    });
  });
});

describe('ListViewport row zones (integration)', () => {
  it('registers a clickable zone per visible row that fires onRowActivate with the row index', async () => {
    const onRowActivate = vi.fn();
    const ui = renderFeature(
      <ListViewport
        items={['a', 'b', 'c']}
        selectedIndex={0}
        getKey={(item) => item}
        rowBudget={5}
        onRowActivate={onRowActivate}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    const seen = new Set<string>();
    for (let y = 1; y <= 12; y++) {
      const zone = hitTopmostZone(1, y);
      if (zone && !seen.has(zone.id)) {
        seen.add(zone.id);
        zone.onClick?.();
      }
    }

    expect(onRowActivate.mock.calls.map((call) => call[0])).toEqual([0, 1, 2]);

    ui.unmount();
  });

  it('registers no zones when onRowActivate is omitted', async () => {
    const ui = renderFeature(
      <ListViewport
        items={['a', 'b']}
        selectedIndex={0}
        getKey={(item) => item}
        rowBudget={5}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );
    await tick();

    expect(hitTopmostZone(1, 1)).toBeUndefined();
    expect(hitTopmostZone(1, 2)).toBeUndefined();

    ui.unmount();
  });

  it('keeps the latest same-id registration when an earlier mount is disposed', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const ui = renderFeature(
      <RowZone zoneId="row:test" z={100} onActivate={first}>
        <Text>v1</Text>
      </RowZone>,
    );
    await tick();
    ui.rerender(
      <RowZone zoneId="row:test" z={100} onActivate={second}>
        <Text>v2</Text>
      </RowZone>,
    );
    await tick();

    for (let y = 1; y <= 6; y++) {
      hitTopmostZone(1, y)?.onClick?.();
    }

    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('remeasures the same logical zone after its row width changes', async () => {
    const activate = vi.fn();
    const ui = renderFeature(
      <Box width={12}>
        <RowZone zoneId="row:stable" z={100} onActivate={activate}>
          <Box width="100%">
            <Text>row</Text>
          </Box>
        </RowZone>
      </Box>,
    );
    await tick();

    expect(hitTopmostZone(12, 1)?.id).toBe('row:stable');
    expect(hitTopmostZone(13, 1)).toBeUndefined();

    ui.rerender(
      <Box width={6}>
        <RowZone zoneId="row:stable" z={100} onActivate={activate}>
          <Box width="100%">
            <Text>row</Text>
          </Box>
        </RowZone>
      </Box>,
    );
    await tick();

    expect(hitTopmostZone(6, 1)?.id).toBe('row:stable');
    expect(hitTopmostZone(7, 1)).toBeUndefined();
    hitTopmostZone(6, 1)?.onClick?.();
    expect(activate).toHaveBeenCalledOnce();
    ui.unmount();
  });
});

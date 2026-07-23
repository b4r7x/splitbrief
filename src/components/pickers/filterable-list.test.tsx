import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { FilterableList } from './filterable-list.js';

const ENTER = '\r';
const VIEWPORT = { cols: 80, rows: 24 };

async function clickListRow(rowKey: string): Promise<void> {
  await flushEffects();
  await vi.waitFor(() => {
    expect(collectClickableZones(VIEWPORT).has(`list-row:${rowKey}`)).toBe(true);
  });
  collectClickableZones(VIEWPORT).get(`list-row:${rowKey}`)?.();
  await flushEffects();
}

beforeEach(() => {
  resetAllStores();
  _resetMouseZones();
  terminalSizeStore.__testReset({ cols: 80, rows: 24 });
});

describe('FilterableList row activation', () => {
  it('routes a row click to onActivate while Enter still confirms', async () => {
    const activated: string[] = [];
    const confirmed: string[] = [];
    const ui = renderFeature(
      <FilterableList
        items={['alpha', 'bravo', 'charlie']}
        filterFn={(item, query) => item.includes(query)}
        getKey={(item) => item}
        onConfirm={(item) => confirmed.push(item)}
        onActivate={(item) => activated.push(item)}
        chromeRows={12}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );

    await clickListRow('bravo');

    await vi.waitFor(() => {
      expect(activated).toEqual(['bravo']);
    });
    expect(confirmed).toEqual([]);

    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    await vi.waitFor(() => {
      expect(confirmed).toEqual(['alpha']);
    });
    expect(activated).toEqual(['bravo']);

    ui.unmount();
  });

  it('falls back to onConfirm for row clicks when onActivate is absent', async () => {
    const confirmed: string[] = [];
    const ui = renderFeature(
      <FilterableList
        items={['alpha', 'bravo']}
        filterFn={(item, query) => item.includes(query)}
        getKey={(item) => item}
        onConfirm={(item) => confirmed.push(item)}
        chromeRows={12}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );

    await clickListRow('bravo');

    await vi.waitFor(() => {
      expect(confirmed).toEqual(['bravo']);
    });

    ui.unmount();
  });
});

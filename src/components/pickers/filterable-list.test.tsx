import { beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { FilterableList } from './filterable-list.js';

const ENTER = '\r';

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
    await tick(20);

    const zones = collectClickableZones({ cols: 80, rows: 24 });
    zones.get('list-row:bravo')?.();
    await tick(20);

    expect(activated).toEqual(['bravo']);
    expect(confirmed).toEqual([]);

    ui.stdin.write(ENTER);
    await tick(20);

    expect(confirmed).toEqual(['alpha']);
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
    await tick(20);

    const zones = collectClickableZones({ cols: 80, rows: 24 });
    zones.get('list-row:bravo')?.();
    await tick(20);

    expect(confirmed).toEqual(['bravo']);

    ui.unmount();
  });
});

import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { ListViewport } from './list-viewport.js';

describe('ListViewport', () => {
  it('caps sectioned lists at maxVisible display rows including headers', async () => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 40, isSmall: false });

    const items = [
      { id: 'p1', scope: 'project' },
      { id: 'p2', scope: 'project' },
      { id: 'p3', scope: 'project' },
      { id: 'g1', scope: 'global' },
      { id: 'g2', scope: 'global' },
      { id: 'g3', scope: 'global' },
    ];

    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={0}
        getKey={(item) => item.id}
        chromeRows={30}
        maxVisible={5}
        section={{
          by: (item) => item.scope,
          renderHeader: (section) => <Text>{section}</Text>,
        }}
        renderItem={(item) => <Text>{item.id}</Text>}
      />,
    );
    await tick(20);

    const lines = (ui.lastFrame() ?? '')
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.includes('more'));
    expect(lines.length).toBeLessThanOrEqual(5);

    ui.unmount();
    resetAllStores();
  });

  it('collapses list content when the viewport has no safe rows', async () => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 6, isSmall: true });

    const ui = renderFeature(
      <ListViewport
        items={[]}
        selectedIndex={0}
        getKey={(item: string) => item}
        chromeRows={12}
        maxVisible={5}
        placeholder={<Text>No rows</Text>}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );
    await tick(20);

    expect(ui.lastFrame() ?? '').not.toContain('No rows');

    ui.unmount();
    resetAllStores();
  });
});

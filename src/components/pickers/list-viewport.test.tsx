import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { ListViewport } from './list-viewport.js';

describe('ListViewport', () => {
  it('renders an explicit row budget including section headers and gaps', async () => {
    resetAllStores();

    const items = [
      { id: 'p1', scope: 'project' },
      { id: 'p2', scope: 'project' },
      { id: 'g1', scope: 'global' },
    ];

    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={0}
        getKey={(item) => item.id}
        rowBudget={6}
        section={{
          by: (item) => item.scope,
          gapBetweenSections: true,
          renderHeader: (section) => <Text>{section}</Text>,
        }}
        renderItem={(item) => <Text>{item.id}</Text>}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    for (const label of ['project', 'p1', 'p2', 'global', 'g1']) {
      expect(frame).toContain(label);
    }
    expect(lines.some((line) => line.trim() === '')).toBe(true);

    ui.unmount();
    resetAllStores();
  });

  it('caps terminal-budget lists at maxVisible display rows including headers', async () => {
    resetAllStores();

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
        rows={40}
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

    const lines = (ui.lastFrame() ?? '').split('\n').filter((line) => line.trim().length > 0);
    expect(lines.map((line) => line.trim())).toEqual(['project', 'p1', 'p2', 'p3', '↓ more']);

    ui.unmount();
    resetAllStores();
  });

  it('collapses list content when the viewport has no safe rows', async () => {
    resetAllStores();

    const ui = renderFeature(
      <ListViewport
        items={[]}
        selectedIndex={0}
        getKey={(item: string) => item}
        rows={6}
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

  it('uses the terminal floor when chrome exceeds rows', async () => {
    resetAllStores();

    const ui = renderFeature(
      <ListViewport
        items={['alpha', 'bravo']}
        selectedIndex={0}
        getKey={(item) => item}
        rows={4}
        chromeRows={12}
        listFloor={2}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('bravo');

    ui.unmount();
    resetAllStores();
  });

  it('counts remaining sectioned items from the last visible global index', async () => {
    resetAllStores();

    const items = [
      { id: 'p1', scope: 'project' },
      { id: 'p2', scope: 'project' },
      { id: 'g1', scope: 'global' },
      { id: 'g2', scope: 'global' },
      { id: 'g3', scope: 'global' },
    ];
    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={2}
        getKey={(item) => item.id}
        rowBudget={4}
        showRemainingCount
        section={{
          by: (item) => item.scope,
          gapBetweenSections: true,
          renderHeader: (section) => <Text>{section}</Text>,
        }}
        renderItem={(item, { globalIndex }) => <Text>{`${item.id}:${globalIndex}`}</Text>}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('g1:2');
    expect(frame).toContain('↓ 2 more');

    ui.unmount();
    resetAllStores();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { glyph } from '../../lib/glyphs.js';
import { ListViewport } from './list-viewport.js';

const SCROLL_THUMB = glyph('scrollThumb');
const SCROLL_TRACK = glyph('scrollTrack');

function countGlyph(frame: string, char: string): number {
  return frame.split('').filter((c) => c === char).length;
}

function nonEmptyLines(frame: string): string[] {
  return frame.split('\n').filter((line) => line.trim().length > 0);
}

function barLines(frame: string): string[] {
  return nonEmptyLines(frame).filter((line) => {
    const last = line.trimEnd().at(-1);
    return last === SCROLL_THUMB || last === SCROLL_TRACK;
  });
}

describe('ListViewport', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders an explicit row budget including section headers and gaps', async () => {
    const items = [
      { id: 'p1', scope: 'project' },
      { id: 'p2', scope: 'project' },
      { id: 'g1', scope: 'global' },
    ];

    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={0}
        width={40}
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
  });

  it('caps terminal-budget lists at maxVisible display rows including headers', async () => {
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
  });

  it('collapses list content when the viewport has no safe rows', async () => {
    const ui = renderFeature(
      <ListViewport
        items={[]}
        selectedIndex={0}
        width={40}
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
  });

  it('uses the terminal floor when chrome exceeds rows', async () => {
    const ui = renderFeature(
      <ListViewport
        items={['alpha', 'bravo']}
        selectedIndex={0}
        width={40}
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
  });

  it('counts remaining sectioned items from the last visible global index', async () => {
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
        width={40}
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
  });
});

describe('ListViewport scrollbar', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('draws a right-edge bar and narrows contentWidth when the window overflows', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    let lastContentWidth: number | undefined;

    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={0}
        width={40}
        getKey={(item) => item}
        rowBudget={5}
        renderItem={(item, { contentWidth }) => {
          lastContentWidth = contentWidth;
          return <Text>{item}</Text>;
        }}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(countGlyph(frame, SCROLL_THUMB) + countGlyph(frame, SCROLL_TRACK)).toEqual(
      barLines(frame).length,
    );
    expect(barLines(frame).length).toBeGreaterThan(0);
    expect(lastContentWidth).toEqual(38);

    ui.unmount();
  });

  it('draws no bar and reports the full width when the window fits', async () => {
    const items = ['a', 'b', 'c'];
    let lastContentWidth: number | undefined;

    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={0}
        width={40}
        getKey={(item) => item}
        rowBudget={10}
        renderItem={(item, { contentWidth }) => {
          lastContentWidth = contentWidth;
          return <Text>{item}</Text>;
        }}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain(SCROLL_THUMB);
    expect(frame).not.toContain(SCROLL_TRACK);
    expect(lastContentWidth).toEqual(40);

    ui.unmount();
  });

  it('puts the thumb at the top of the bar when the cursor is at the start', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={0}
        width={40}
        getKey={(item) => item}
        rowBudget={5}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const bar = barLines(frame);
    expect(bar[0]?.trimEnd().at(-1)).toEqual(SCROLL_THUMB);

    ui.unmount();
  });

  it('puts the thumb at the bottom of the bar when the cursor is at the end', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={19}
        width={40}
        getKey={(item) => item}
        rowBudget={5}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const bar = barLines(frame);
    expect(bar.at(-1)?.trimEnd().at(-1)).toEqual(SCROLL_THUMB);

    ui.unmount();
  });

  it('sizes the bar to slot-space, not item-space, for a sectioned overflowing list', async () => {
    const items = [
      { id: 'a1', scope: 'a' },
      { id: 'a2', scope: 'a' },
      { id: 'a3', scope: 'a' },
      { id: 'b1', scope: 'b' },
      { id: 'b2', scope: 'b' },
      { id: 'b3', scope: 'b' },
      { id: 'c1', scope: 'c' },
      { id: 'c2', scope: 'c' },
      { id: 'c3', scope: 'c' },
    ];

    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={0}
        width={40}
        getKey={(item) => item.id}
        rowBudget={5}
        section={{
          by: (item) => item.scope,
          renderHeader: (section) => <Text>{section}</Text>,
        }}
        renderItem={(item) => <Text>{item.id}</Text>}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const bar = barLines(frame);
    expect(bar.length).toBeGreaterThan(0);
    expect(countGlyph(frame, SCROLL_THUMB) + countGlyph(frame, SCROLL_TRACK)).toEqual(bar.length);

    ui.unmount();
  });

  it('draws no bar for an empty list even when width is supplied', async () => {
    const ui = renderFeature(
      <ListViewport
        items={[]}
        selectedIndex={0}
        width={40}
        getKey={(item: string) => item}
        rowBudget={5}
        placeholder={<Text>No rows</Text>}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('No rows');
    expect(frame).not.toContain(SCROLL_THUMB);
    expect(frame).not.toContain(SCROLL_TRACK);

    ui.unmount();
  });

  it('renders nothing when rowBudget is 0 even with width supplied', async () => {
    const ui = renderFeature(
      <ListViewport
        items={['a', 'b']}
        selectedIndex={0}
        width={40}
        getKey={(item) => item}
        rowBudget={0}
        renderItem={(item) => <Text>{item}</Text>}
      />,
    );
    await tick(20);

    expect(ui.lastFrame() ?? '').toEqual('');

    ui.unmount();
  });

  it('does not crash and clamps contentWidth to 1 at a very narrow width', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    let lastContentWidth: number | undefined;

    const ui = renderFeature(
      <ListViewport
        items={items}
        selectedIndex={0}
        width={2}
        getKey={(item) => item}
        rowBudget={5}
        renderItem={(item, { contentWidth }) => {
          lastContentWidth = contentWidth;
          return <Text>{item}</Text>;
        }}
      />,
    );
    await tick(20);

    expect(lastContentWidth).toEqual(1);

    ui.unmount();
  });
});

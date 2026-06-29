import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { useFilterableList } from './use-filterable-list.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';

const DOWN = '\u001b[B';
const ENTER = '\r';
const ESC = '\u001b';
const BACKSPACE = '\x7f';
const HOME = '\u001b[H';
const END = '\u001b[F';
const PAGE_UP = '\u001b[5~';
const PAGE_DOWN = '\u001b[6~';

function Harness({
  items,
  initialIndex,
  pageSize = 3,
}: {
  items: string[];
  initialIndex?: number | undefined;
  pageSize?: number | undefined;
}) {
  const [chosen, setChosen] = useState('none');
  const [closed, setClosed] = useState(false);
  const list = useFilterableList({
    items,
    initialIndex,
    onSelect: setChosen,
    onClose: () => setClosed(true),
    filterFn: (item, query) => item.includes(query),
    pageSize,
  });
  const current = list.filtered[list.selectedIndex] ?? 'none';
  return (
    <Text>
      {`filter:${list.filter}|current:${current}|chosen:${chosen}|closed:${closed ? 'yes' : 'no'}`}
    </Text>
  );
}

describe('useFilterableList', () => {
  it('filters, navigates, selects, clears input, and closes from keyboard input', async () => {
    const ui = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} />);
    await tick(20);

    expect(ui.lastFrame()).toContain('filter:|current:alpha|chosen:none|closed:no');

    ui.stdin.write(DOWN);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:beta');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:beta');

    ui.stdin.write('g');
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:g|current:gamma');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:gamma');

    ui.stdin.write(BACKSPACE);
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:|current:alpha');

    ui.stdin.write(ESC);
    await tick(20);
    expect(ui.lastFrame()).toContain('closed:yes');

    ui.unmount();
  });

  it('selects from queued keyboard state before an intermediate render flushes', async () => {
    const byArrow = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} />);
    await tick(20);

    byArrow.stdin.write(DOWN);
    byArrow.stdin.write(ENTER);
    await tick(20);

    expect(byArrow.lastFrame()).toContain('current:beta|chosen:beta');
    byArrow.unmount();

    const byFilter = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} />);
    await tick(20);

    byFilter.stdin.write('g');
    byFilter.stdin.write(ENTER);
    await tick(20);

    expect(byFilter.lastFrame()).toContain('filter:g|current:gamma|chosen:gamma');
    byFilter.unmount();
  });

  it('keeps the visible selection valid when the item list changes', async () => {
    const ui = renderFeature(<Harness items={['alpha', 'beta']} initialIndex={10} />);
    await tick(20);

    expect(ui.lastFrame()).toContain('current:beta');

    ui.rerender(<Harness items={[]} initialIndex={10} />);
    await tick(20);

    expect(ui.lastFrame()).toContain('current:none|chosen:none');

    ui.rerender(<Harness items={['solo']} initialIndex={10} />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:solo');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:solo');

    ui.unmount();
  });

  it('supports Home, End, PageUp, and PageDown including filtered and empty lists', async () => {
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`);
    const ui = renderFeature(<Harness items={items} pageSize={3} />);
    await tick(20);

    ui.stdin.write(END);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:item-11');

    ui.stdin.write(HOME);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:item-0');

    ui.stdin.write(PAGE_DOWN);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:item-3');

    ui.stdin.write(PAGE_UP);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:item-0');

    ui.stdin.write('item-9');
    await tick(20);
    expect(ui.lastFrame()).toContain('current:item-9');

    ui.stdin.write(BACKSPACE);
    ui.stdin.write('1');
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:item-1|current:item-1');

    ui.stdin.write(PAGE_DOWN);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:item-11');

    ui.stdin.write(PAGE_UP);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:item-1');

    ui.stdin.write('zzzz');
    await tick(20);
    expect(ui.lastFrame()).toContain('current:none');

    ui.stdin.write(PAGE_DOWN);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:none');

    ui.unmount();
  });

  it('does not select on Enter when the page has no visible rows (pageSize 0)', async () => {
    const ui = renderFeature(<Harness items={['alpha', 'beta']} pageSize={0} />);
    await tick(20);

    expect(ui.lastFrame()).toContain('current:alpha|chosen:none');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:none');

    ui.unmount();
  });

  it('deletes a full emoji with one backspace', async () => {
    const ui = renderFeature(<Harness items={['alpha']} />);
    await tick(20);

    ui.stdin.write('😀');
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:😀');

    ui.stdin.write(BACKSPACE);
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:|current:alpha');

    ui.unmount();
  });
});

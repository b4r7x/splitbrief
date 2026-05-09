import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { useFilterableList } from './use-filterable-list.js';
import { renderFeature, tick } from '../../testing/helpers/ink.js';

const DOWN = '\u001b[B';
const ENTER = '\r';
const ESC = '\u001b';
const BACKSPACE = '\x7f';

function Harness({
  items,
  initialIndex,
}: {
  items: string[];
  initialIndex?: number | undefined;
}) {
  const [chosen, setChosen] = useState('none');
  const [closed, setClosed] = useState(false);
  const list = useFilterableList({
    items,
    initialIndex,
    onSelect: setChosen,
    onClose: () => setClosed(true),
    filterFn: (item, query) => item.includes(query),
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
});

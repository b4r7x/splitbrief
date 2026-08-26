import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { useFilterableList } from './use-filterable-list.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';

const DOWN = '\u001b[B';
const UP = '\u001b[A';
const ENTER = '\r';
const ESC = '\u001b';
const BACKSPACE = '\x7f';
const HOME = '\u001b[H';
const END = '\u001b[F';
const PAGE_UP = '\u001b[5~';
const PAGE_DOWN = '\u001b[6~';
const KITTY_SUPER_A = '\u001b[97;9u';
const KITTY_HYPER_A = '\u001b[97;17u';
const LONE_CONTROL = '\x1f';

function Harness({
  items,
  initialKey,
  initialFilter,
  pageSize = 3,
  upAtStart,
  onCommit,
  shouldAppendChar,
}: {
  items: string[];
  initialKey?: string | undefined;
  initialFilter?: string | undefined;
  pageSize?: number | undefined;
  upAtStart?: 'wrap' | 'close' | undefined;
  onCommit?: ((event: string) => void) | undefined;
  shouldAppendChar?: ((input: string) => boolean) | undefined;
}) {
  const [chosen, setChosen] = useState('none');
  const [acted, setActed] = useState('none');
  const [closed, setClosed] = useState(0);
  const list = useFilterableList({
    items,
    getKey: (item) => item,
    initialKey,
    initialFilter,
    onSelect: (item) => {
      onCommit?.(`select:${item}`);
      setChosen(item);
    },
    onItemAction: (item) => {
      onCommit?.(`action:${item}`);
      setActed(item);
    },
    onClose: () => {
      onCommit?.('close');
      setClosed((count) => count + 1);
    },
    filterFn: (item, query) => item.includes(query),
    pageSize,
    upAtStart,
    ...(shouldAppendChar ? { shouldAppendChar } : {}),
    customKeys: (input, key, { runSelectedItemAction }) => {
      if (input !== 'y' || key.ctrl || key.meta) return false;
      runSelectedItemAction();
      return true;
    },
  });
  const current = list.filtered[list.selectedIndex] ?? 'none';
  return (
    <Text>
      {`filter:${list.filter}|current:${current}|chosen:${chosen}|acted:${acted}|closed:${closed}|count:${list.filtered.length}`}
    </Text>
  );
}

interface KeyedItem {
  id: string;
  label: string;
}

function ObjectHarness({
  items,
  onCommit,
}: {
  items: KeyedItem[];
  onCommit: (event: string) => void;
}) {
  const list = useFilterableList({
    items,
    getKey: (item) => item.id,
    filterFn: (item, query) => item.label.includes(query),
    onSelect: (item) => onCommit(`select:${item.id}:${item.label}`),
    onItemAction: (item) => onCommit(`action:${item.id}:${item.label}`),
    pageSize: 3,
    customKeys: (input, _key, { runSelectedItemAction }) => {
      if (input !== 'y') return false;
      runSelectedItemAction();
      return true;
    },
  });
  const current = list.filtered[list.selectedIndex];
  return <Text>{current === undefined ? 'none' : `${current.id}:${current.label}`}</Text>;
}

describe('useFilterableList', () => {
  it('filters, navigates, selects, clears input, and closes from keyboard input', async () => {
    const ui = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} />);
    await tick(20);

    expect(ui.lastFrame()).toContain('filter:|current:alpha|chosen:none|acted:none|closed:0');

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
    expect(ui.lastFrame()).toContain('closed:1');

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

  it('applies the append predicate only to ordinary text input', async () => {
    const events: string[] = [];
    const ui = renderFeature(
      <Harness
        items={['alpha', 'beta', 'gamma']}
        shouldAppendChar={(input) => /^[a-z]+$/i.test(input)}
        onCommit={(event) => events.push(event)}
      />,
    );
    await tick(20);

    ui.stdin.write(DOWN);
    ui.stdin.write(ENTER);
    await tick(20);
    expect(events).toEqual(['select:beta']);

    ui.stdin.write('1');
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:|current:beta');

    ui.stdin.write(KITTY_SUPER_A);
    ui.stdin.write(KITTY_HYPER_A);
    ui.stdin.write(LONE_CONTROL);
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:|current:beta');

    ui.stdin.write('g');
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:g|current:gamma');

    ui.stdin.write(ESC);
    await tick(20);
    expect(events).toEqual(['select:beta', 'close']);
    ui.unmount();
  });

  it('targets replacement objects by stable key through prepend and reorder', async () => {
    const events: string[] = [];
    const ui = renderFeature(
      <ObjectHarness
        items={[
          { id: 'a', label: 'alpha-old' },
          { id: 'b', label: 'beta-old' },
          { id: 'c', label: 'gamma-old' },
        ]}
        onCommit={(event) => events.push(event)}
      />,
    );
    await tick(20);

    ui.stdin.write(DOWN);
    await tick(20);

    ui.rerender(
      <ObjectHarness
        items={[
          { id: 'd', label: 'delta-new' },
          { id: 'c', label: 'gamma-new' },
          { id: 'b', label: 'beta-new' },
          { id: 'a', label: 'alpha-new' },
        ]}
        onCommit={(event) => events.push(event)}
      />,
    );
    await tick(20);

    ui.stdin.write('y');
    ui.stdin.write(ENTER);
    await tick(20);
    expect(events).toEqual(['action:b:beta-new', 'select:b:beta-new']);

    ui.unmount();
  });

  it('keeps the first filtered key through reorder and reconciles removal and empty lists', async () => {
    const ui = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} initialKey="beta" />);
    await tick(20);

    ui.stdin.write('a');
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:a|current:alpha');

    ui.rerender(<Harness items={['gamma', 'beta', 'alpha']} initialKey="beta" />);
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:a|current:alpha');

    ui.rerender(<Harness items={['gamma', 'beta']} initialKey="beta" />);
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:a|current:gamma');

    ui.rerender(<Harness items={[]} initialKey="beta" />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:none');

    ui.rerender(<Harness items={['delta', 'gamma']} initialKey="beta" />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:delta');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:delta');

    ui.unmount();
  });

  it('opens on a seeded filter with the cursor on its first match', async () => {
    const ui = renderFeature(
      <Harness items={['alpha', 'temperature', 'gamma']} initialFilter="temp" />,
    );
    await tick(20);

    expect(ui.lastFrame()).toContain('filter:temp|current:temperature');
    expect(ui.lastFrame()).toContain('count:1');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:temperature');

    ui.unmount();
  });

  it('targets item actions from queued keyboard state', async () => {
    const afterDown = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} />);
    await tick(20);

    afterDown.stdin.write(DOWN);
    afterDown.stdin.write('y');
    await tick(20);
    expect(afterDown.lastFrame()).toContain('current:beta|chosen:none|acted:beta');
    afterDown.unmount();

    const afterAction = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} />);
    await tick(20);

    afterAction.stdin.write('y');
    afterAction.stdin.write(DOWN);
    await tick(20);
    expect(afterAction.lastFrame()).toContain('current:beta|chosen:none|acted:alpha');
    afterAction.unmount();
  });

  it('commits a nonterminal item action before queued filter and selection', async () => {
    const events: string[] = [];
    const ui = renderFeature(
      <Harness items={['alpha', 'beta', 'gamma']} onCommit={(event) => events.push(event)} />,
    );
    await tick(20);

    ui.stdin.write('y');
    ui.stdin.write('g');
    ui.stdin.write(ENTER);
    await tick(20);

    expect(events).toEqual(['action:alpha', 'select:gamma']);
    expect(ui.lastFrame()).toContain('filter:g|current:gamma|chosen:gamma|acted:alpha');
    ui.unmount();
  });

  it('commits a nonterminal item action before select and close terminal actions', async () => {
    const selectedEvents: string[] = [];
    const selected = renderFeature(
      <Harness items={['alpha', 'beta']} onCommit={(event) => selectedEvents.push(event)} />,
    );
    await tick(20);

    selected.stdin.write('y');
    selected.stdin.write(ENTER);
    await tick(20);
    expect(selectedEvents).toEqual(['action:alpha', 'select:alpha']);
    selected.unmount();

    const upEvents: string[] = [];
    const closedByUp = renderFeature(
      <Harness
        items={['alpha', 'beta']}
        upAtStart="close"
        onCommit={(event) => upEvents.push(event)}
      />,
    );
    await tick(20);

    closedByUp.stdin.write('y');
    closedByUp.stdin.write(UP);
    await tick(20);
    expect(upEvents).toEqual(['action:alpha', 'close']);
    closedByUp.unmount();

    const escapeEvents: string[] = [];
    const closedByEscape = renderFeature(
      <Harness items={['alpha', 'beta']} onCommit={(event) => escapeEvents.push(event)} />,
    );
    await tick(20);

    closedByEscape.stdin.write('y');
    closedByEscape.stdin.write(ESC);
    await tick(20);
    expect(escapeEvents).toEqual(['action:alpha', 'close']);
    closedByEscape.unmount();
  });

  it('lets the first terminal action suppress trailing input in the same flush', async () => {
    const upEvents: string[] = [];
    const closedByUp = renderFeature(
      <Harness
        items={['alpha', 'beta']}
        upAtStart="close"
        onCommit={(event) => upEvents.push(event)}
      />,
    );
    await tick(20);

    closedByUp.stdin.write(UP);
    closedByUp.stdin.write(ENTER);
    await tick(20);
    expect(upEvents).toEqual(['close']);
    closedByUp.unmount();

    const escapeEvents: string[] = [];
    const closedByEscape = renderFeature(
      <Harness items={['alpha', 'beta']} onCommit={(event) => escapeEvents.push(event)} />,
    );
    await tick(20);

    closedByEscape.stdin.write(ESC);
    await tick();
    closedByEscape.stdin.write(ENTER);
    await tick(20);
    expect(escapeEvents).toEqual(['close']);
    closedByEscape.unmount();

    const selectEvents: string[] = [];
    const selected = renderFeature(
      <Harness items={['alpha', 'beta']} onCommit={(event) => selectEvents.push(event)} />,
    );
    await tick(20);

    selected.stdin.write(ENTER);
    selected.stdin.write(ENTER);
    await tick(20);
    expect(selectEvents).toEqual(['select:alpha']);
    selected.unmount();
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
    const events: string[] = [];
    const ui = renderFeature(
      <Harness items={['alpha', 'beta']} pageSize={0} onCommit={(event) => events.push(event)} />,
    );
    await tick(20);

    expect(ui.lastFrame()).toContain('current:alpha|chosen:none');

    ui.stdin.write('y');
    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:none');
    expect(events).toEqual([]);

    ui.unmount();
  });

  it('appendToFilter from customKeys appends space while typing', async () => {
    function Harness() {
      const list = useFilterableList({
        items: ['alpha'],
        getKey: (item) => item,
        filterFn: (item, query) => item.includes(query),
        onSelect: () => {},
        pageSize: 3,
        customKeys: (input, key, { appendToFilter }) => {
          if (input === ' ' && !key.ctrl) {
            appendToFilter(' ');
            return true;
          }
          return false;
        },
      });
      return <Text>{`filter:[${list.filter}]`}</Text>;
    }
    const ui = renderFeature(<Harness />);
    await tick(20);
    ui.stdin.write('a');
    await tick(20);
    ui.stdin.write(' ');
    await tick(20);
    expect(ui.lastFrame()).toContain('filter:[a ]');
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

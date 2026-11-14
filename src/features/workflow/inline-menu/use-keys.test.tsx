import { Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { settleSlashHandoff, startSlashHandoff } from '../slash-handoff.js';
import { useInlineMenuKeys } from './use-keys.js';

const DOWN = '\u001B[B';
const ROWS = ['stop', 'pause', 'end'] as const;

function renderKeys({
  focused = true,
  listRows = 3,
  initialIndex,
}: {
  focused?: boolean;
  listRows?: number;
  initialIndex?: number;
} = {}) {
  const onSelect = vi.fn<(row: string) => void>();
  const onTab = vi.fn<() => void>();
  function Menu() {
    const selectedIndex = useInlineMenuKeys({
      items: ROWS,
      keyOf: (row) => row,
      initialIndex,
      focused,
      listRows,
      onSelect,
      onTab,
    });
    return <Text>{`cursor ${selectedIndex}`}</Text>;
  }
  const ui = renderFeature(<Menu />);
  return { ui, onSelect, onTab };
}

describe('useInlineMenuKeys', () => {
  afterEach(() => {
    settleSlashHandoff();
  });

  it('moves the cursor and takes the row under it on Enter', async () => {
    const { ui, onSelect, onTab } = renderKeys();
    await flushEffects();
    ui.stdin.write(DOWN);
    await flushEffects();

    expect(ui.lastFrame()).toBe('cursor 1');
    ui.stdin.write('\r');
    await flushEffects();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toBe('pause');
    expect(onTab).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('starts on the initial row', async () => {
    const { ui, onSelect } = renderKeys({ initialIndex: 2 });
    await flushEffects();

    expect(ui.lastFrame()).toBe('cursor 2');
    ui.stdin.write('\r');
    await flushEffects();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toBe('end');
    ui.unmount();
  });

  it('takes no row on Enter while no list row is in view', async () => {
    const { ui, onSelect } = renderKeys({ listRows: 0 });
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(onSelect).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('takes no row in the read whose slash handed the keys to the composer, and still lets go on Tab', async () => {
    const { ui, onSelect, onTab } = renderKeys();
    await flushEffects();
    startSlashHandoff();
    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(ui.lastFrame()).toBe('cursor 0');
    expect(onSelect).not.toHaveBeenCalled();
    ui.stdin.write('\t');
    await flushEffects();
    expect(onTab).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('hands the keys on with Tab', async () => {
    const { ui, onSelect, onTab } = renderKeys();
    await flushEffects();
    ui.stdin.write('\t');
    await flushEffects();

    expect(onTab).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('reads no key while the composer holds the keys', async () => {
    const { ui, onSelect, onTab } = renderKeys({ focused: false });
    await flushEffects();
    for (const key of [DOWN, '\r', '\t']) {
      ui.stdin.write(key);
      await flushEffects();
    }

    expect(ui.lastFrame()).toBe('cursor 0');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onTab).not.toHaveBeenCalled();
    ui.unmount();
  });
});

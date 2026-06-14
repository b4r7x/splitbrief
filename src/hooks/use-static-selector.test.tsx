import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { useStaticSelector } from './use-static-selector.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ENTER = '\r';
const ESC = '\u001b';

function Harness({ items, initialIndex }: { items: string[]; initialIndex?: number | undefined }) {
  const [chosen, setChosen] = useState('none');
  const [cancelled, setCancelled] = useState(false);
  const selector = useStaticSelector({
    items,
    initialIndex,
    onSelect: (item, index) => setChosen(`${item}@${index}`),
    onCancel: () => setCancelled(true),
  });
  const current = items[selector.selectedIndex] ?? 'none';
  return <Text>{`current:${current}|chosen:${chosen}|cancelled:${cancelled ? 'yes' : 'no'}`}</Text>;
}

describe('useStaticSelector', () => {
  it('wraps through choices, selects the visible item, and cancels from keyboard input', async () => {
    const ui = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} />);
    await tick(20);

    expect(ui.lastFrame()).toContain('current:alpha|chosen:none|cancelled:no');

    ui.stdin.write(UP);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('current:gamma');
    });

    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('chosen:gamma@2');
    });

    ui.stdin.write(DOWN);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('current:alpha');
    });

    ui.stdin.write(ESC);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('cancelled:yes');
    });

    ui.unmount();
  });

  it('keeps the visible selection valid when the item list shrinks or empties', async () => {
    const ui = renderFeature(<Harness items={['alpha', 'beta', 'gamma']} initialIndex={2} />);
    await tick(20);

    expect(ui.lastFrame()).toContain('current:gamma');

    ui.rerender(<Harness items={['alpha']} initialIndex={2} />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:alpha');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:alpha@0');

    ui.rerender(<Harness items={[]} initialIndex={2} />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:none');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:alpha@0');

    ui.unmount();
  });
});

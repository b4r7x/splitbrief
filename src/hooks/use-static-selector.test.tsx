import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { useStaticSelector } from './use-static-selector.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ENTER = '\r';
const ESC = '\u001b';

function Harness({
  items,
  initialIndex,
  keyed,
}: {
  items: string[];
  initialIndex?: number | undefined;
  keyed?: boolean | undefined;
}) {
  const [chosen, setChosen] = useState('none');
  const [cancelled, setCancelled] = useState(false);
  const selector = useStaticSelector({
    items,
    initialIndex,
    keyOf: keyed === true ? (item) => item : undefined,
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

    await flushEffects();
    ui.stdin.write(UP);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('current:gamma');
    });

    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('chosen:gamma@2');
    });

    await flushEffects();
    ui.stdin.write(DOWN);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('current:alpha');
    });

    await flushEffects();
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

    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:alpha@0');

    ui.rerender(<Harness items={[]} initialIndex={2} />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:none');

    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('chosen:alpha@0');

    ui.unmount();
  });

  it('with keyOf the cursor follows its row when the list re-derives under it', async () => {
    const items = ['alpha', 'beta', 'gamma', 'delta'];
    const ui = renderFeature(<Harness items={items} keyed />);
    await tick(20);

    await flushEffects();
    ui.stdin.write(DOWN);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('current:beta');
    });

    ui.rerender(<Harness items={['beta', 'gamma', 'delta']} keyed />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:beta');

    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('chosen:beta@0');
    });

    ui.rerender(<Harness items={['gamma', 'delta']} keyed />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:gamma');

    ui.unmount();
  });

  it('ignores keys while shouldHandleInput is false and handles them once it opens', async () => {
    let open = false;

    function GatedHarness({ items }: { items: string[] }) {
      const [chosen, setChosen] = useState('none');
      const selector = useStaticSelector({
        items,
        shouldHandleInput: () => open,
        onSelect: (item, index) => setChosen(`${item}@${index}`),
      });
      const current = items[selector.selectedIndex] ?? 'none';
      return <Text>{`current:${current}|chosen:${chosen}`}</Text>;
    }

    const ui = renderFeature(<GatedHarness items={['alpha', 'beta', 'gamma']} />);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:alpha|chosen:none');

    await flushEffects();
    ui.stdin.write(DOWN);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:alpha|chosen:none');

    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);
    expect(ui.lastFrame()).toContain('current:alpha|chosen:none');

    open = true;
    await flushEffects();
    ui.stdin.write(DOWN);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('current:beta');
    });

    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('chosen:beta@1');
    });

    ui.unmount();
  });
});

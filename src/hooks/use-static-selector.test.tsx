import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { useStaticSelector } from './use-static-selector.js';
import { renderFeature, tick } from '../../testing/helpers/ink.js';

function Harness({
  items,
  initialIndex,
  onSelect,
}: {
  items: string[];
  initialIndex?: number | undefined;
  onSelect: (item: string, index: number) => void;
}) {
  const selector = useStaticSelector({
    items,
    initialIndex,
    onSelect,
  });
  return <Text>{selector.selectedIndex}</Text>;
}

describe('useStaticSelector', () => {
  it('clamps initial negative and oversized indexes', async () => {
    const negativeUi = renderFeature(
      <Harness items={['a', 'b']} initialIndex={-5} onSelect={vi.fn()} />,
    );
    await tick();

    expect(negativeUi.lastFrame()).toBe('0');
    negativeUi.unmount();

    const oversizedUi = renderFeature(
      <Harness items={['a', 'b']} initialIndex={10} onSelect={vi.fn()} />,
    );
    await tick();

    expect(oversizedUi.lastFrame()).toBe('1');
    oversizedUi.unmount();
  });

  it('selects the clamped index after a list shrinks', async () => {
    const onSelect = vi.fn();
    const ui = renderFeature(
      <Harness items={['a', 'b', 'c']} initialIndex={2} onSelect={onSelect} />,
    );
    await tick();

    expect(ui.lastFrame()).toBe('2');

    ui.rerender(<Harness items={['a']} initialIndex={2} onSelect={onSelect} />);
    await tick();

    expect(ui.lastFrame()).toBe('0');

    ui.stdin.write('\r');
    await tick();

    expect(onSelect).toHaveBeenCalledWith('a', 0);
    ui.unmount();
  });

  it('keeps an empty list at index zero and does not select missing items', async () => {
    const onSelect = vi.fn();
    const ui = renderFeature(
      <Harness items={[]} initialIndex={4} onSelect={onSelect} />,
    );
    await tick();

    expect(ui.lastFrame()).toBe('0');

    ui.stdin.write('\r');
    await tick();

    expect(onSelect).not.toHaveBeenCalled();
    ui.unmount();
  });
});

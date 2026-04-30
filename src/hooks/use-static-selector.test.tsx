import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { useStaticSelector } from './use-static-selector.js';
import { renderFeature, tick } from '../../testing/helpers/ink.js';

interface Capture {
  current: { selectedIndex: number } | null;
}

function Harness({
  items,
  initialIndex,
  onSelect,
  capture,
}: {
  items: string[];
  initialIndex?: number | undefined;
  onSelect: (item: string, index: number) => void;
  capture: Capture;
}) {
  const selector = useStaticSelector({
    items,
    initialIndex,
    onSelect,
  });
  capture.current = selector;
  return <Text>{selector.selectedIndex}</Text>;
}

describe('useStaticSelector', () => {
  it('clamps initial negative and oversized indexes', async () => {
    const negative: Capture = { current: null };
    const negativeUi = renderFeature(
      <Harness items={['a', 'b']} initialIndex={-5} onSelect={vi.fn()} capture={negative} />,
    );
    await tick();

    expect(negative.current?.selectedIndex).toBe(0);
    negativeUi.unmount();

    const oversized: Capture = { current: null };
    const oversizedUi = renderFeature(
      <Harness items={['a', 'b']} initialIndex={10} onSelect={vi.fn()} capture={oversized} />,
    );
    await tick();

    expect(oversized.current?.selectedIndex).toBe(1);
    oversizedUi.unmount();
  });

  it('selects the clamped index after a list shrinks', async () => {
    const capture: Capture = { current: null };
    const onSelect = vi.fn();
    const ui = renderFeature(
      <Harness items={['a', 'b', 'c']} initialIndex={2} onSelect={onSelect} capture={capture} />,
    );
    await tick();

    expect(capture.current?.selectedIndex).toBe(2);

    ui.rerender(<Harness items={['a']} initialIndex={2} onSelect={onSelect} capture={capture} />);
    await tick();

    expect(capture.current?.selectedIndex).toBe(0);

    ui.stdin.write('\r');
    await tick();

    expect(onSelect).toHaveBeenCalledWith('a', 0);
    ui.unmount();
  });

  it('keeps an empty list at index zero and does not select missing items', async () => {
    const capture: Capture = { current: null };
    const onSelect = vi.fn();
    const ui = renderFeature(
      <Harness items={[]} initialIndex={4} onSelect={onSelect} capture={capture} />,
    );
    await tick();

    expect(capture.current?.selectedIndex).toBe(0);

    ui.stdin.write('\r');
    await tick();

    expect(onSelect).not.toHaveBeenCalled();
    ui.unmount();
  });
});

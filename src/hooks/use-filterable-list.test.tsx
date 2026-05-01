import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { useFilterableList } from './use-filterable-list.js';
import { renderFeature, tick } from '../../testing/helpers/ink.js';

function Harness({
  items,
  initialIndex,
  onSelect,
}: {
  items: string[];
  initialIndex?: number | undefined;
  onSelect: (item: string) => void;
}) {
  const list = useFilterableList({
    items,
    initialIndex,
    onSelect,
    filterFn: (item, query) => item.includes(query),
  });
  return <Text>{list.selectedIndex}</Text>;
}

describe('useFilterableList', () => {
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

  it('reports a safe index for empty and shrinking lists', async () => {
    const ui = renderFeature(
      <Harness items={['a', 'b', 'c']} initialIndex={2} onSelect={vi.fn()} />,
    );
    await tick();

    expect(ui.lastFrame()).toBe('2');

    ui.rerender(<Harness items={[]} initialIndex={2} onSelect={vi.fn()} />);
    await tick();

    expect(ui.lastFrame()).toBe('0');

    ui.rerender(<Harness items={['only']} initialIndex={2} onSelect={vi.fn()} />);
    await tick();

    expect(ui.lastFrame()).toBe('0');
    ui.unmount();
  });
});

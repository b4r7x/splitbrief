import { describe, expect, it } from 'vitest';
import { Box, Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { glyph } from '../lib/glyphs.js';
import { ScrollableDocument } from './scrollable-document.js';

const HOME = '\u001b[H';
const END = '\u001b[F';
const PAGE_UP = '\u001b[5~';
const PAGE_DOWN = '\u001b[6~';
const CTRL_B = '\x02';
const CTRL_F = '\x06';
const ARROW_UP = '\u001b[A';
const ARROW_DOWN = '\u001b[B';

function makeRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    key: `row-${i}`,
    node: <Text>{`line-${i}`}</Text>,
  }));
}

function makeMultiLineRows() {
  return [
    {
      key: 'tall-0',
      lines: 4,
      node: (
        <Box flexDirection="column">
          <Text>block-a-0</Text>
          <Text>block-a-1</Text>
          <Text>block-a-2</Text>
          <Text>block-a-3</Text>
        </Box>
      ),
    },
    { key: 'tail', node: <Text>tail-row</Text> },
  ];
}

describe('ScrollableDocument', () => {
  it('shows the scroll-down indicator when content exceeds the viewport', async () => {
    const ui = renderFeature(<ScrollableDocument rows={makeRows(8)} height={3} />);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('more');
    expect(ui.lastFrame() ?? '').toContain('line-0');

    ui.unmount();
  });

  it('hides both indicator rows when lineCount <= visibleHeight', async () => {
    const ui = renderFeature(<ScrollableDocument rows={makeRows(3)} height={3} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toBe('line-0\nline-1\nline-2');
    expect(frame).not.toContain('more');

    ui.unmount();
  });

  it('pages down by viewport height and reaches the last rows', async () => {
    const ui = renderFeature(<ScrollableDocument rows={makeRows(8)} height={3} />);
    await tick(20);

    ui.stdin.write(PAGE_DOWN);
    await tick(20);
    ui.stdin.write(PAGE_DOWN);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('line-7');
    expect(frame).toContain('more');

    ui.stdin.write(PAGE_UP);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('line-2');

    ui.unmount();
  });

  it('supports Ctrl+B and Ctrl+F as page key fallbacks', async () => {
    const ui = renderFeature(<ScrollableDocument rows={makeRows(8)} height={3} />);
    await tick(20);

    ui.stdin.write(CTRL_F);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('line-3');

    ui.stdin.write(CTRL_B);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('line-0');

    ui.unmount();
  });

  it('jumps home and end', async () => {
    const ui = renderFeature(<ScrollableDocument rows={makeRows(8)} height={3} />);
    await tick(20);

    ui.stdin.write(END);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('line-7');

    ui.stdin.write(HOME);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('line-0');

    ui.unmount();
  });

  it('scrolls one line at a time in line-and-page mode', async () => {
    const ui = renderFeature(
      <ScrollableDocument rows={makeRows(6)} height={3} keyboardMode="line-and-page" />,
    );
    await tick(20);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('line-1');
    expect(ui.lastFrame() ?? '').not.toContain('line-0');

    ui.stdin.write(ARROW_UP);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('line-0');

    ui.unmount();
  });

  it('ignores keyboard input when isActive is false', async () => {
    const ui = renderFeature(<ScrollableDocument rows={makeRows(8)} height={3} isActive={false} />);
    await tick(20);

    ui.stdin.write(PAGE_DOWN);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('line-0');
    expect(ui.lastFrame() ?? '').not.toContain('line-3');

    ui.unmount();
  });

  it('clamps scroll offset when rows shrink', async () => {
    const ui = renderFeature(<ScrollableDocument rows={makeRows(8)} height={3} />);
    await tick(20);

    ui.stdin.write(END);
    await tick(20);

    ui.rerender(<ScrollableDocument rows={makeRows(2)} height={3} />);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('line-1');

    ui.unmount();
  });

  it('renders placeholder when there are no rows', async () => {
    const ui = renderFeature(
      <ScrollableDocument rows={[]} height={3} placeholder={<Text>empty-doc</Text>} />,
    );
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('empty-doc');

    ui.unmount();
  });

  it('renders an internal scrollbar gutter when showScrollbar overflows', async () => {
    const ui = renderFeature(
      <ScrollableDocument
        rows={makeRows(8)}
        height={3}
        width={20}
        showScrollbar
        showScrollIndicators={false}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(glyph('scrollThumb'));
    expect(frame).toContain(glyph('scrollTrack'));
    expect(frame).toContain('line-0');

    ui.unmount();
  });

  it('omits the scrollbar gutter when content fits the viewport', async () => {
    const ui = renderFeature(
      <ScrollableDocument
        rows={makeRows(2)}
        height={5}
        width={20}
        showScrollbar
        showScrollIndicators={false}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain(glyph('scrollThumb'));
    expect(frame).not.toContain(glyph('scrollTrack'));

    ui.unmount();
  });

  it('accounts for multi-line row height when paging', async () => {
    const ui = renderFeature(<ScrollableDocument rows={makeMultiLineRows()} height={2} />);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('block-a-0');
    expect(ui.lastFrame() ?? '').not.toContain('block-a-3');
    expect(ui.lastFrame() ?? '').not.toContain('tail-row');

    ui.stdin.write(PAGE_DOWN);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('block-a-2');
    expect(ui.lastFrame() ?? '').toContain('block-a-3');

    ui.stdin.write(END);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('block-a-3');
    expect(ui.lastFrame() ?? '').toContain('tail-row');

    ui.unmount();
  });
});

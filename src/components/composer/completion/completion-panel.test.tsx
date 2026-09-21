import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { glyph } from '../../../lib/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { CompletionPanel } from './completion-panel.js';

const ITEMS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

function panelLines(frame: string): string[] {
  return stripAnsiStyles(frame)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
}

function visibleItems(frame: string): string[] {
  const lines = panelLines(frame);
  return ITEMS.filter((item) => lines.some((line) => line.includes(item)));
}

function itemRows(frame: string, needle: string): string[] {
  return panelLines(frame).filter((line) => line.includes(needle));
}

describe('CompletionPanel', () => {
  afterEach(() => {
    terminalSizeStore.reset();
  });

  it('renders a bordered panel and marks the selected row with a cursor', () => {
    const ui = render(
      <Box width={60}>
        <CompletionPanel
          items={ITEMS.slice(0, 3)}
          selectedIndex={0}
          maxVisible={3}
          footer="select · esc close"
          itemKey={(item) => item}
          renderRow={({ item, isSelected }) => (
            <Text>
              {isSelected ? glyph('cursor') : ' '}
              {item}
            </Text>
          )}
        />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('|');
    expect(frame).toContain(glyph('cursor'));
    expect(frame).not.toContain('▌');
    ui.unmount();
  });

  it('occludes underlying transcript text when overlaid absolutely', () => {
    terminalSizeStore.__testReset({ cols: 80 });
    const underlying = 'UNDERLYING'.repeat(6);
    const ui = render(
      <Box height={12} width={60} overflow="visible">
        <Box flexDirection="column">
          {Array.from({ length: 10 }, (_, index) => (
            <Text key={index}>{underlying}</Text>
          ))}
        </Box>
        <Box position="absolute" marginTop={1} width={60}>
          <CompletionPanel
            items={ITEMS.slice(0, 3)}
            selectedIndex={0}
            maxVisible={3}
            footer="select · esc close"
            itemKey={(item) => item}
            renderRow={({ item, isSelected }) => (
              <Text>
                {isSelected ? glyph('cursor') : ' '}
                {item}
              </Text>
            )}
          />
        </Box>
      </Box>,
    );

    const lines = (ui.lastFrame() ?? '').split('\n');
    const footerIndex = lines.findIndex((line) => line.includes('select'));
    expect(footerIndex).toBeGreaterThan(0);
    for (const line of lines.slice(footerIndex - 4, footerIndex + 1)) {
      expect(line.slice(0, 60)).not.toContain('UNDERLYING');
    }
    ui.unmount();
  });

  // The workflow composer stands one gutter in from a rule that runs edge to edge. Covering the
  // rule from the card's own border left its first cell butting into the border as `─│`.
  it('blanks the cell left of the card, so a rule it covers stops short of the border', () => {
    terminalSizeStore.__testReset({ cols: 40 });
    const rule = glyph('divider').repeat(40);
    const ui = render(
      <Box height={8} width={40} overflow="visible">
        <Box flexDirection="column">
          {Array.from({ length: 8 }, (_, index) => (
            <Text key={index}>{rule}</Text>
          ))}
        </Box>
        <Box position="absolute" marginLeft={1} marginTop={1} width={38}>
          <CompletionPanel
            items={ITEMS.slice(0, 3)}
            selectedIndex={0}
            maxVisible={3}
            footer="select · esc close"
            itemKey={(item) => item}
            renderRow={({ item }) => <Text>{item}</Text>}
          />
        </Box>
      </Box>,
    );

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const footerIndex = lines.findIndex((line) => line.includes('select'));
    expect(footerIndex).toBeGreaterThan(0);
    expect(lines[footerIndex]?.[0]).toBe(' ');
    expect(lines[footerIndex]?.[1]).toMatch(/[│|]/);
    ui.unmount();
  });

  it('keeps narrow panels to a single visible row plus the footer', () => {
    const ui = render(
      <Box width={24}>
        <CompletionPanel
          items={ITEMS}
          selectedIndex={0}
          maxVisible={1}
          footer="select · esc close"
          itemKey={(item) => item}
          renderRow={({ item }) => <Text>{item}</Text>}
        />
      </Box>,
    );

    const lines = panelLines(ui.lastFrame() ?? '');
    expect(lines.filter((line) => line.includes('alpha'))).toHaveLength(1);
    for (const hidden of ITEMS.slice(1)) {
      expect(lines.some((line) => line.includes(hidden))).toBe(false);
    }
    expect(lines.some((line) => line.includes('select'))).toBe(true);
    ui.unmount();
  });

  it('walks the cursor to the window edge before sliding the list', () => {
    const ui = render(
      <Box width={40}>
        <CompletionPanel
          items={ITEMS}
          selectedIndex={0}
          maxVisible={3}
          footer="select · esc close"
          itemKey={(item) => item}
          renderRow={({ item }) => <Text>{item}</Text>}
        />
      </Box>,
    );
    const rerenderAt = (selectedIndex: number) =>
      ui.rerender(
        <Box width={40}>
          <CompletionPanel
            items={ITEMS}
            selectedIndex={selectedIndex}
            maxVisible={3}
            footer="select · esc close"
            itemKey={(item) => item}
            renderRow={({ item }) => <Text>{item}</Text>}
          />
        </Box>,
      );

    expect(visibleItems(ui.lastFrame() ?? '')).toEqual(['alpha', 'bravo', 'charlie']);

    rerenderAt(3);
    expect(visibleItems(ui.lastFrame() ?? '')).toEqual(['bravo', 'charlie', 'delta']);

    rerenderAt(4);
    expect(visibleItems(ui.lastFrame() ?? '')).toEqual(['charlie', 'delta', 'echo']);

    rerenderAt(2);
    expect(visibleItems(ui.lastFrame() ?? '')).toEqual(['charlie', 'delta', 'echo']);

    rerenderAt(0);
    expect(visibleItems(ui.lastFrame() ?? '')).toEqual(['alpha', 'bravo', 'charlie']);
    ui.unmount();
  });

  it('ellipsises a clipped row and keeps a pad between it, the counter and the bar', () => {
    terminalSizeStore.__testReset({ cols: 40 });
    const overflowing = Array.from({ length: 12 }, (_, index) => `${index}-${'x'.repeat(58)}`);
    const ui = render(
      <Box width={40}>
        <CompletionPanel
          items={overflowing}
          selectedIndex={0}
          maxVisible={3}
          footer="select · esc close"
          itemKey={(item) => item}
          renderRow={({ item }) => <Text wrap="truncate-end">{item}</Text>}
        />
      </Box>,
    );

    const rows = itemRows(ui.lastFrame() ?? '', 'xxx');
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toContain('↑');
    expect(rows.at(-1)).toMatch(/…\s+↓9\s/);
    const barColumns = rows.map((row) =>
      Math.max(row.lastIndexOf(glyph('scrollTrack')), row.lastIndexOf(glyph('scrollThumb'))),
    );
    expect(barColumns[0]).toBeGreaterThan(0);
    expect(new Set(barColumns).size).toBe(1);
    ui.unmount();
  });
});

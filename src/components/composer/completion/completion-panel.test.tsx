import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
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

describe('CompletionPanel', () => {
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
});

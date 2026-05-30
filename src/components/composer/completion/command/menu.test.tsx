import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';
import { CommandCompletionMenu } from './menu.js';

const COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: 'Show help overlay [Ctrl+/]',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/palette',
    label: 'Palette',
    description: 'Open command palette',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/skills',
    label: 'Skills',
    description: 'Select planner skills [Ctrl+S]',
    validScreens: ['home'],
    handler: () => {},
  },
];

function panelInteriorRows(frame: string): string[] {
  return frame
    .split('\n')
    .filter((line) => line.includes('│'))
    .map((line) => line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')));
}

describe('CommandCompletionMenu', () => {
  it('paints opaque rows over underlying terminal content', () => {
    const ui = render(
      <Box height={12} width={90} overflow="visible">
        <Box flexDirection="column">
          {Array.from({ length: 10 }, (_, index) => (
            <Text key={index}>{'UNDERLYING TEXT '.repeat(6)}</Text>
          ))}
        </Box>
        <Box position="absolute" marginTop={1} width={80}>
          <CommandCompletionMenu filtered={COMMANDS} selectedIndex={0} maxVisible={3} />
        </Box>
      </Box>,
    );

    const rows = panelInteriorRows(ui.lastFrame() ?? '');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row).not.toContain('UNDERLYING');
    }
    ui.unmount();
  });
});

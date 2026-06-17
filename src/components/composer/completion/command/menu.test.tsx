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
    description: 'Show help overlay',
    shortcut: 'Ctrl+/',
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

const LONG_HINT_COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: 'Show help overlay with enough detail to pressure the hint column',
    shortcut: 'Ctrl+/',
    validScreens: ['home'],
    handler: () => {},
  },
];

const SCROLLED_COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/hidden-command-with-a-very-long-name',
    label: 'Hidden Long Command',
    description: 'Hidden command should not size visible rows',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/run',
    label: 'Run',
    description: 'Run focused task',
    shortcut: 'Ctrl+R',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/test',
    label: 'Test',
    description: 'Run target tests with enough detail to pressure the row',
    shortcut: 'Ctrl+T',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/ship',
    label: 'Ship',
    description: 'Prepare review handoff',
    shortcut: 'Ctrl+S',
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

function rowContaining(rows: string[], text: string): string {
  const row = rows.find((line) => line.includes(text));
  expect(row).toBeDefined();
  return row ?? '';
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

  it('keeps narrow panels to the computed one-row footer height', () => {
    const ui = render(
      <Box width={22}>
        <CommandCompletionMenu filtered={COMMANDS.slice(0, 1)} selectedIndex={0} maxVisible={1} />
      </Box>,
    );

    const rows = panelInteriorRows(ui.lastFrame() ?? '');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rowContaining(rows, '/help')).toContain('/help');
    ui.unmount();
  });

  it('keeps command shortcuts visible when descriptions overflow', () => {
    const ui = render(
      <Box width={46}>
        <CommandCompletionMenu filtered={LONG_HINT_COMMANDS} selectedIndex={0} maxVisible={1} />
      </Box>,
    );

    const rows = panelInteriorRows(ui.lastFrame() ?? '');
    const helpRow = rowContaining(rows, '/help');
    expect(helpRow).toContain('[Ctrl+/]');
    expect(rows.filter((line) => line.includes('[Ctrl+/]'))).toHaveLength(1);
    ui.unmount();
  });

  it('shows visible commands within the panel row budget', () => {
    const ui = render(
      <Box width={80}>
        <CommandCompletionMenu filtered={COMMANDS} selectedIndex={0} maxVisible={3} />
      </Box>,
    );

    const rows = panelInteriorRows(ui.lastFrame() ?? '');
    expect(rows.length).toBeLessThanOrEqual(5);

    const helpRow = rowContaining(rows, '/help');
    expect(helpRow).toContain('▸');
    expect(helpRow).toContain('Show help overlay');

    expect(
      rows.some((line) => line.includes('/palette') && line.includes('Open command palette')),
    ).toBe(true);
    expect(
      rows.some((line) => line.includes('/skills') && line.includes('Select planner skills')),
    ).toBe(true);
    ui.unmount();
  });

  it('keeps the selected scrolled command and shortcut visible within the row budget', () => {
    const ui = render(
      <Box width={42}>
        <CommandCompletionMenu filtered={SCROLLED_COMMANDS} selectedIndex={2} maxVisible={2} />
      </Box>,
    );

    const rows = panelInteriorRows(ui.lastFrame() ?? '');
    const commandRows = rows.filter((line) => line.includes('/'));
    expect(rows.length).toBeLessThanOrEqual(6);
    expect(commandRows.length).toBeLessThanOrEqual(2);
    expect(commandRows.join('\n')).not.toContain('/hidden-command');
    expect(commandRows.some((line) => line.includes('/run'))).toBe(true);

    const testRow = rowContaining(commandRows, '/test');
    expect(testRow).toContain('▸');
    expect(testRow).toContain('[Ctrl+T]');
    expect(rows.filter((line) => line.includes('[Ctrl+T]'))).toHaveLength(1);
    ui.unmount();
  });
});

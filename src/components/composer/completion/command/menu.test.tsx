import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { CommandCompletionMenu } from './menu.js';
import { glyph } from '../../../../lib/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';

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

const FUZZY_COMMAND: RuntimeCommandDef = {
  kind: 'noarg',
  name: '/help',
  label: 'Help',
  description: 'Show help overlay',
  validScreens: ['home'],
  handler: () => {},
};

function panelLines(frame: string): string[] {
  return stripAnsiStyles(frame)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
}

function commandLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes('/'));
}

function rowContaining(rows: string[], text: string): string {
  const row = rows.find((line) => line.includes(text));
  expect(row).toBeDefined();
  return row ?? '';
}

describe('CommandCompletionMenu', () => {
  it('keeps command shortcuts visible as a de-badged dim key when descriptions overflow', () => {
    const ui = render(
      <Box width={46}>
        <CommandCompletionMenu filtered={LONG_HINT_COMMANDS} selectedIndex={0} maxVisible={1} />
      </Box>,
    );

    const lines = panelLines(ui.lastFrame() ?? '');
    const helpRow = rowContaining(lines, '/help');
    expect(helpRow).toContain('Ctrl+/');
    expect(helpRow).not.toContain('[Ctrl+/]');
    expect(lines.filter((line) => line.includes('Ctrl+/'))).toHaveLength(1);
    ui.unmount();
  });

  it('shows visible commands and marks the selected row', () => {
    const ui = render(
      <Box width={80}>
        <CommandCompletionMenu filtered={COMMANDS} selectedIndex={0} maxVisible={3} />
      </Box>,
    );

    const lines = panelLines(ui.lastFrame() ?? '');
    expect(commandLines(lines).length).toBeLessThanOrEqual(3);

    const helpRow = rowContaining(lines, '/help');
    expect(helpRow).toContain(glyph('cursor'));
    expect(helpRow).not.toContain('▌');
    expect(helpRow).toContain('Show help overlay');

    expect(
      lines.some((line) => line.includes('/palette') && line.includes('Open command palette')),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes('/skills') && line.includes('Select planner skills')),
    ).toBe(true);
    ui.unmount();
  });

  it('keeps the selected scrolled command and shortcut visible within the row budget', () => {
    const ui = render(
      <Box width={42}>
        <CommandCompletionMenu filtered={SCROLLED_COMMANDS} selectedIndex={2} maxVisible={2} />
      </Box>,
    );

    const lines = panelLines(ui.lastFrame() ?? '');
    const commandRows = commandLines(lines);
    expect(commandRows.length).toBeLessThanOrEqual(2);
    expect(commandRows.join('\n')).not.toContain('/hidden-command');
    expect(commandRows.some((line) => line.includes('/run'))).toBe(true);

    const testRow = rowContaining(commandRows, '/test');
    expect(testRow).toContain(glyph('cursor'));
    expect(testRow).not.toContain('▌');
    expect(testRow).toContain('Ctrl+T');
    expect(testRow).not.toContain('[Ctrl+T]');
    expect(lines.filter((line) => line.includes('Ctrl+T'))).toHaveLength(1);
    ui.unmount();
  });

  it('aligns the fuzzy fallback row to the same left gutter as normal command rows', () => {
    const normal = render(
      <Box width={80}>
        <CommandCompletionMenu filtered={[FUZZY_COMMAND]} selectedIndex={0} maxVisible={3} />
      </Box>,
    );
    const normalCol = rowContaining(panelLines(normal.lastFrame() ?? ''), '/help').indexOf('/help');
    normal.unmount();

    const fuzzy = render(
      <Box width={80}>
        <CommandCompletionMenu
          filtered={[]}
          selectedIndex={0}
          fuzzyMatch={FUZZY_COMMAND}
          maxVisible={3}
        />
      </Box>,
    );
    const fuzzyCol = rowContaining(panelLines(fuzzy.lastFrame() ?? ''), '/help').indexOf('/help');
    fuzzy.unmount();

    expect(fuzzyCol).toBe(normalCol);
  });

  it('renders a quiet "no matching commands" line when nothing matches', () => {
    const ui = render(
      <Box width={80}>
        <CommandCompletionMenu filtered={[]} selectedIndex={0} maxVisible={3} />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('no matching commands');
    expect(frame).not.toContain('▌');
    expect(frame).not.toContain(glyph('cursor'));
    ui.unmount();
  });

  it('renders a fuzzy fallback row without a cursor glyph', () => {
    const ui = render(
      <Box width={80}>
        <CommandCompletionMenu
          filtered={[]}
          selectedIndex={0}
          fuzzyMatch={FUZZY_COMMAND}
          maxVisible={3}
        />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('(fuzzy)');
    expect(frame).not.toContain(glyph('cursor'));
    expect(frame).not.toContain('▌');
    ui.unmount();
  });

  it('drops footer tokens to the abbreviated form below the narrow width gate', () => {
    terminalSizeStore.__testReset({ cols: 40 });
    const ui = render(
      <Box width={40}>
        <CommandCompletionMenu filtered={COMMANDS} selectedIndex={0} maxVisible={3} />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('↑↓ · ⏎ · esc');
    expect(frame).not.toContain('select');
    expect(frame).not.toContain('tab fill');
    ui.unmount();
    terminalSizeStore.__testReset({ cols: 80 });
  });
});

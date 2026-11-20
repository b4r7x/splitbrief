import chalk from 'chalk';
import { defaultTheme } from '../../../theme.js';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { CommandCompletionMenu, type CommandCompletionRow } from './menu.js';
import { glyph } from '../../../../lib/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';

const COMMANDS: CommandCompletionRow[] = [
  { name: '/help', description: 'Show help overlay', trailing: 'Ctrl+/' },
  { name: '/palette', description: 'Open command palette' },
  { name: '/skills', description: 'Select planner skills [Ctrl+S]' },
];

const LONG_HINT_COMMANDS: CommandCompletionRow[] = [
  {
    name: '/help',
    description: 'Show help overlay with enough detail to pressure the hint column',
    trailing: 'Ctrl+/',
  },
];

const SCROLLED_COMMANDS: CommandCompletionRow[] = [
  {
    name: '/hidden-command-with-a-very-long-name',
    description: 'The whole list sizes the name column, capped, not the visible slice',
  },
  { name: '/run', description: 'Run focused task', trailing: 'Ctrl+R' },
  {
    name: '/test',
    description: 'Run target tests with enough detail to pressure the row',
    trailing: 'Ctrl+T',
  },
  { name: '/ship', description: 'Prepare review handoff', trailing: 'Ctrl+S' },
];

// The shape `/skills <id>` really produces: ids longer than the 18-cell cap, descriptions that
// overflow any window, one pseudo-entry whose name differs from its id, and a tail of short ids.
const LONG_SKILL_DESCRIPTION =
  'Sprites, tilemaps, physics, camera, input and the game loop, with the pitfalls each one hides';

const SKILL_ROWS: CommandCompletionRow[] = [
  { name: 'splitbrief-add-feature', description: LONG_SKILL_DESCRIPTION },
  { name: 'splitbrief-implement-spec', description: LONG_SKILL_DESCRIPTION },
  { name: '2d-games', description: LONG_SKILL_DESCRIPTION },
  { name: 'agents-root', description: 'AGENTS.md — Root agent instructions' },
  { name: 'splitbrief-docs-sync', description: LONG_SKILL_DESCRIPTION },
  { name: 'ai-agents-architect', description: LONG_SKILL_DESCRIPTION },
  { name: 'frontend-design', description: LONG_SKILL_DESCRIPTION },
  { name: 'web-performance-optimization', description: LONG_SKILL_DESCRIPTION },
  { name: '3d-games', description: LONG_SKILL_DESCRIPTION },
  { name: 'react-guard', description: LONG_SKILL_DESCRIPTION },
  { name: 'hono', description: LONG_SKILL_DESCRIPTION },
  { name: 'typescript', description: LONG_SKILL_DESCRIPTION },
];

const FUZZY_COMMAND: RuntimeCommandDef = {
  kind: 'noarg',
  name: '/help',
  label: 'Help',
  description: 'Show help overlay',
  category: 'navigate',
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
  if (row === undefined) throw new Error(`Missing completion row: ${text}`);
  return row;
}

describe('CommandCompletionMenu', () => {
  afterEach(() => {
    terminalSizeStore.reset();
  });

  it.each([120, 80, 60])(
    'spans the supplied composer width for one match at %i columns',
    (cols) => {
      terminalSizeStore.__testReset({ cols, rows: 24 });
      const width = cols - 2;
      const ui = render(
        <Box width={width}>
          <CommandCompletionMenu
            filtered={[{ name: 'brief', description: 'Copy the brief' }]}
            selectedIndex={0}
            maxVisible={3}
            width={width}
          />
        </Box>,
      );
      try {
        const row = rowContaining(panelLines(ui.lastFrame() ?? ''), 'Copy the brief');
        expect(row).toMatch(/^[|│].*[|│]$/u);
        expect(row).toHaveLength(width);
      } finally {
        ui.unmount();
      }
    },
  );

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
    expect(helpRow).toContain(glyph('liveBar'));
    expect(helpRow).not.toContain(glyph('cursor'));
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
    expect(testRow).toContain(glyph('liveBar'));
    expect(testRow).not.toContain(glyph('cursor'));
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

  it('wraps skill descriptions inside the shared column and keeps the scrollbar clear', () => {
    const ui = render(
      <Box width={60}>
        <CommandCompletionMenu width={60} filtered={SKILL_ROWS} selectedIndex={0} maxVisible={4} />
      </Box>,
    );
    const rows = panelLines(ui.lastFrame() ?? '');
    const first = rowContaining(rows, 'splitbrief-add');
    const column = first.indexOf('Sprites');
    expect(first).toMatch(/splitbrief-add[^ ]*… {2}Sprites/);
    expect(column).toBeGreaterThan(0);
    const continuation = rows[rows.indexOf(first) + 1] ?? '';
    expect(continuation.slice(1, column).trim()).toBe('');
    expect(continuation.slice(column)).toMatch(/^\S/);
    expect(rows.join('\n')).not.toMatch(/\S↓\d/);
    ui.unmount();
  });

  it('bands every visible line of the selected skill', () => {
    const previous = chalk.level;
    chalk.level = 3;
    const ui = render(
      <CommandCompletionMenu width={60} filtered={SKILL_ROWS} selectedIndex={0} maxVisible={2} />,
    );
    try {
      const lines = (ui.lastFrame() ?? '').split('\n');
      const first = lines.findIndex((line) => stripAnsiStyles(line).includes('Sprites'));
      expect(first).toBeGreaterThan(0);
      const band = chalk.bgHex(defaultTheme.selectionBg!)('x').split('x')[0]!;
      expect(lines[first]).toContain(band);
      expect(lines[first + 1]).toContain(band);
    } finally {
      ui.unmount();
      chalk.level = previous;
    }
  });

  it('counts hidden entries when only part of a skill description is visible', () => {
    const rows = ['alpha', 'beta', 'gamma'].map((name) => ({
      name,
      description: 'one two three four five six seven eight nine ten '.repeat(4),
    }));
    const ui = render(
      <CommandCompletionMenu width={46} filtered={rows} selectedIndex={0} maxVisible={2} />,
    );
    try {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('alpha');
      expect(frame).not.toContain('beta');
      expect(frame).toMatch(/↓2\s/);
      ui.rerender(
        <CommandCompletionMenu width={46} filtered={rows} selectedIndex={2} maxVisible={2} />,
      );
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(/↑[12]\s/);
    } finally {
      ui.unmount();
    }
  });

  it('sizes the name column from the whole filtered list as selection scrolls', () => {
    const menu = (index: number) => (
      <Box width={60}>
        <CommandCompletionMenu
          width={60}
          filtered={SKILL_ROWS}
          selectedIndex={index}
          maxVisible={4}
        />
      </Box>
    );
    const ui = render(menu(0));
    const firstColumn = rowContaining(panelLines(ui.lastFrame() ?? ''), 'splitbrief-add').indexOf(
      'Sprites',
    );
    ui.rerender(menu(11));
    const lastColumn = rowContaining(panelLines(ui.lastFrame() ?? ''), 'typescript').indexOf(
      'Sprites',
    );
    expect(firstColumn).toBeGreaterThan(0);
    expect(lastColumn).toBe(firstColumn);
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
  });
});

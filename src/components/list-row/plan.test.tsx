import { afterEach, beforeEach, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { HelpOverlay } from '../../app/overlays/help.js';
import { CommandPaletteOverlay } from '../../app/overlays/palette.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { configStore } from '../../stores/project/config.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { CommandCompletionMenu } from '../composer/completion/command/menu.js';

const viewport = { cols: 120, rows: 40 };
const commands: RuntimeCommandDef[] = ['/files', '/recent-project-files'].map((name) => ({
  kind: 'noarg',
  name,
  description: name === '/files' ? 'Browse files' : 'Browse recent files',
  category: 'navigate',
  validScreens: ['home'],
  handler: () => {},
}));

beforeEach(() => {
  configStore.__testReset({ config: makeConfig() });
  terminalSizeStore.__testReset(viewport);
});

afterEach(() => {
  configStore.reset();
  terminalSizeStore.reset();
});

it('uses the same name and description columns in the palette, Help and inline completion', () => {
  const surfaces = {
    palette: <CommandPaletteOverlay commands={commands} onRuntimeCommand={() => {}} />,
    help: <HelpOverlay currentScreen="home" commands={commands} />,
    completion: <CommandCompletionMenu filtered={commands} selectedIndex={0} maxVisible={2} />,
  };
  const columns: Record<string, number> = {};
  for (const [surface, menu] of Object.entries(surfaces)) {
    const ui = renderFeature(menu, viewport);
    try {
      const line = stripAnsiStyles(ui.lastFrame())
        .split('\n')
        .find((row) => row.includes('/files'));
      expect(line, surface).toContain('Browse files');
      if (line !== undefined)
        columns[surface] = line.indexOf('Browse files') - line.indexOf('/files');
    } finally {
      ui.unmount();
    }
  }
  const column = '/recent-project-files'.length + 2;
  expect(columns).toEqual({ palette: column, help: column, completion: column });
});

it('puts a description under its name when fewer than twenty cells remain beside it', () => {
  const narrow = { cols: 28, rows: 18 };
  terminalSizeStore.__testReset(narrow);
  const ui = renderFeature(
    <CommandCompletionMenu filtered={commands.slice(0, 1)} selectedIndex={0} maxVisible={3} />,
    narrow,
  );
  try {
    const lines = stripAnsiStyles(ui.lastFrame()).split('\n');
    const nameRow = lines.findIndex((line) => line.includes('/files'));
    expect(nameRow).toBeGreaterThanOrEqual(0);
    const nameColumn = lines[nameRow]?.indexOf('/files');
    expect(lines[nameRow + 1]?.indexOf('Browse files')).toBe(nameColumn);
  } finally {
    ui.unmount();
  }
});

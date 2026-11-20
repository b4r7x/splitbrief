import Xterm from '@xterm/headless';
import { afterAll, expect, it, vi } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { resolveTheme } from '../../core/theme/resolve.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { FilterableList } from '../pickers/filterable-list.js';
import { ThemeProvider } from '../theme.js';

const savedForceColor = vi.hoisted(() => {
  const saved = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '3';
  return saved;
});
afterAll(() => {
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
});

it.each([
  { variant: 'dark', panel: 0x1f2233, active: 0x363a4e },
  { variant: 'light', panel: 0xf6f7f9, active: 0xe1e4ea },
] as const)(
  'fills the $variant picker and the full active row, including their blank cells',
  async ({ variant, panel, active }) => {
    const viewport = { cols: 80, rows: 24 };
    terminalSizeStore.__testReset({ ...viewport, isSmall: false });
    const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
    const ui = renderFeature(
      <ThemeProvider theme={theme}>
        <FilterableList
          items={['Alpha', 'Beta']}
          getKey={(item) => item}
          filterFn={() => true}
          onConfirm={() => {}}
          title="Options"
          hint="esc close"
          chromeRows={12}
          density="roomy"
          rowModel={(item) => ({ name: item, nameParts: [{ text: item, color: theme.planner }] })}
        />
      </ThemeProvider>,
      viewport,
    );
    const terminal = new Xterm.Terminal({ ...viewport, allowProposedApi: true, convertEol: true });
    try {
      await new Promise<void>((resolve) => terminal.write(ui.lastFrame(), resolve));
      const buffer = terminal.buffer.active;
      const lineAt = (phrase: string) => {
        for (let y = 0; y < viewport.rows; y++) {
          const line = buffer.getLine(y);
          if (line?.translateToString().includes(phrase)) return line;
        }
        throw new Error(`Missing picker line: ${phrase}`);
      };
      const first = lineAt('Alpha');
      const second = lineAt('Beta');
      const x = first.translateToString().indexOf('Alpha');
      for (const column of [x, x + 15]) {
        expect(first.getCell(column)?.getBgColor()).toBe(active);
        expect(second.getCell(column)?.getBgColor()).toBe(panel);
        expect(lineAt('esc close').getCell(column)?.getBgColor()).toBe(panel);
      }
      expect(first.getCell(x)?.getFgColor()).toBe(Number.parseInt(theme.planner!.slice(1), 16));
      expect(first.getCell(0)?.isBgDefault()).toBeTruthy();
    } finally {
      ui.unmount();
      terminal.dispose();
    }
  },
);

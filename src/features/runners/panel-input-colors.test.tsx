import Xterm from '@xterm/headless';
import { afterAll, expect, it, vi } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { readForegroundAtText } from '#testing/e2e/helpers/terminal-cells.js';
import { ThemeProvider } from '../../components/theme.js';
import { resolveTheme } from '../../core/theme/resolve.js';
import { LocalConnectionForm } from './local-connection/form.js';
import { TextInputOverlay } from './text-input-overlay.js';

const originalForceColor = vi.hoisted(() => {
  const saved = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
});

const address = 'http://localhost:11434/v1';
const command = 'custom-planner --json';

it.each([
  {
    variant: 'light',
    value: address,
    form: (
      <LocalConnectionForm
        role="planner"
        provider="ollama"
        seat={{ apiBase: address }}
        check={vi.fn()}
        onSave={vi.fn()}
      />
    ),
  },
  {
    variant: 'dark',
    value: command,
    form: (
      <TextInputOverlay
        title="Custom command"
        role="planner"
        label="Command to run"
        placeholder="Enter a command"
        initialValue={command}
        onSubmit={vi.fn()}
      />
    ),
  },
] as const)(
  'paints the $variant runner field value with the panel text color',
  async ({ variant, value, form }) => {
    const viewport = { cols: 80, rows: 24 };
    const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
    const ui = renderFeature(<ThemeProvider theme={theme}>{form}</ThemeProvider>, viewport);
    const terminal = new Xterm.Terminal({ ...viewport, allowProposedApi: true, convertEol: true });
    try {
      await new Promise<void>((resolve) => terminal.write(ui.lastFrame(), resolve));
      expect(readForegroundAtText(terminal.buffer.active, value)).toEqual({
        mode: 'rgb',
        color: theme.text,
      });
    } finally {
      ui.unmount();
      terminal.dispose();
    }
  },
);

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { flushEffects } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { getTheme } from '../../../src/components/theme.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { COMMANDS, renderDockedComposer } from '#testing/helpers/composer.js';

const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

function colorOpen(color: string): string {
  const ui = render(<Text color={color}>x</Text>);
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  const prefix = frame.slice(0, frame.indexOf('x'));
  if (!prefix) throw new Error(`no color prefix rendered for ${color}`);
  return prefix;
}

function ansiRunEnclosing(frame: string, literal: string): string {
  const index = frame.indexOf(literal);
  if (index < 0) throw new Error(`expected frame to contain ${literal}`);
  const before = frame.slice(0, index);
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const runs = [...before.matchAll(ansiPattern)].map((match) => match[0]);
  return runs.at(-1) ?? '';
}

function expectFrameUsesThemeColor(raw: string, color: string, literal: string): void {
  const prefix = colorOpen(color);
  expect(ansiRunEnclosing(raw, literal)).toBe(prefix);
}

describe('composer in-box footer hints', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders override keys inside the rounded box and nothing else beside them', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      boxHints: { keys: 'Ctrl+D diff' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Ctrl+D diff');
    expect(frame).not.toContain('tab');
    expect(frame).not.toContain('$');
    expectFrameUsesThemeColor(frame, getTheme().textDim, 'Ctrl+D diff');
    ui.unmount();
  });

  it('stands the hint down rather than squeezing the input below its readable minimum', async () => {
    terminalSizeStore.__testReset({ cols: 36, rows: 20, isSmall: false });
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      boxHints: { keys: 'Ctrl+G' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('Ctrl+G');
    ui.unmount();
  });
});

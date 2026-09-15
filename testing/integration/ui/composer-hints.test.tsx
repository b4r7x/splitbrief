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

  it('renders override keys and the cost token inside the rounded box', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      boxHints: { keys: 'Ctrl+D diff', cost: '$0.03', costTone: 'text' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Ctrl+D diff');
    expect(frame).not.toContain('tab');
    expect(frame).toContain('$0.03');
    ui.unmount();
  });

  it('renders warning-toned cost beside override keys in question mode', async () => {
    const cost = '$0.41';
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: '',
      boxHints: { keys: 'Ctrl+D diff', cost, costTone: 'warning' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(cost);
    expectFrameUsesThemeColor(frame, getTheme().warning, cost);

    ui.unmount();
  });

  it('drops the cost token rather than the keys when the box is too narrow for both', async () => {
    terminalSizeStore.__testReset({ cols: 36, rows: 20, isSmall: false });
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Ctrl+G');
    expect(frame).not.toContain('$0.41');
    ui.unmount();
  });
});

import { listRowLead } from '../../../components/list-row.js';
import chalk from 'chalk';
import { defaultTheme } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { ResultMenu } from './menu.js';

const originalColorLevel = chalk.level;

const DOWN = '\x1b[B';

function renderMenu(
  input: { override?: boolean; findings?: string[]; focused?: boolean; height?: number } = {},
) {
  const onCommand = vi.fn<(raw: string) => void>();
  const onShowDiff = vi.fn<() => void>();
  const onFocusChange = vi.fn<(menuFocused: boolean) => void>();
  function ControlledMenu() {
    const [confirming, setConfirming] = useState(false);
    return (
      <ResultMenu
        override={input.override ?? false}
        findings={input.findings ?? []}
        files={4}
        focused={input.focused ?? true}
        height={input.height}
        confirming={confirming}
        onConfirmingChange={setConfirming}
        onFocusChange={onFocusChange}
        onCommand={onCommand}
        onShowDiff={onShowDiff}
      />
    );
  }
  const ui = renderFeature(<ControlledMenu />);
  return { ui, onCommand, onShowDiff, onFocusChange };
}

describe('ResultMenu', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
  });

  afterEach(() => {
    chalk.level = originalColorLevel;
    resetAllStores();
  });

  it.each([60, 120])(
    'keeps action names and wrapped dim consequences separate at %s columns',
    async (cols) => {
      chalk.level = 3;
      terminalSizeStore.__testReset({ cols, rows: 40 });
      const { ui } = renderMenu();
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.accent, `${listRowLead('active')}Apply`).replace('\u001b[39m', ''),
      );
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.text, 'Show diff').replace('\u001b[39m', ''),
      );
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.textDim, ' · ').replace('\u001b[39m', ''),
      );
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.textDim, ' · open the run’s changes').replace('\u001b[39m', ''),
      );
      await flushEffects();
      ui.stdin.write(DOWN);
      await flushEffects();
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.accent, `${listRowLead('active')}Show diff`).replace('\u001b[39m', ''),
      );
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.textDim, ' · open the run’s changes').replace('\u001b[39m', ''),
      );
      ui.unmount();
    },
  );

  it('paints Apply, Show diff and Discard with the legend', async () => {
    const { ui } = renderMenu();
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Ready to apply');
    expect(frame).toContain('Apply');
    expect(frame).toContain('Show diff');
    expect(frame).toContain('Discard');
    expect(frame).toContain('tab type a command');
    ui.unmount();
  });

  it('drops whole facts from a title too wide for the row', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const { ui } = renderMenu({ override: true, findings: ['missing null check', 'stale doc'] });
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Ready to apply as is · 2 open findings');
    expect(frame).not.toContain('…');
    ui.unmount();
  });

  it('applies through /run accept on Enter', async () => {
    const { ui, onCommand } = renderMenu();
    await flushEffects();
    ui.stdin.write('\r');
    await tick(30);

    expect(onCommand).toHaveBeenCalledWith('/run accept');
    ui.unmount();
  });

  it('discards through /run reject confirm', async () => {
    const { ui, onCommand } = renderMenu();
    await flushEffects();
    ui.stdin.write(DOWN);
    await tick(30);
    ui.stdin.write(DOWN);
    await tick(30);
    ui.stdin.write('\r');
    await tick(30);

    expect(onCommand).toHaveBeenCalledWith('/run reject confirm');
    ui.unmount();
  });

  it('opens the diff from Show diff', async () => {
    const { ui, onShowDiff, onCommand } = renderMenu();
    await flushEffects();
    ui.stdin.write(DOWN);
    await tick(30);
    ui.stdin.write('\r');
    await tick(30);

    expect(onShowDiff).toHaveBeenCalledTimes(1);
    expect(onCommand).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('hands the keyboard to the composer on Tab', async () => {
    const { ui, onFocusChange } = renderMenu();
    await flushEffects();
    ui.stdin.write('\t');
    await tick(30);

    expect(onFocusChange).toHaveBeenCalledWith(false);
    ui.unmount();
  });

  it('binds no bare letters', async () => {
    const { ui, onCommand, onShowDiff } = renderMenu();
    await flushEffects();
    for (const letter of ['a', 'd', 's', 'x']) {
      ui.stdin.write(letter);
      await tick(10);
    }

    expect(onCommand).not.toHaveBeenCalled();
    expect(onShowDiff).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('marks no action and offers only Tab while the composer holds focus', async () => {
    const { ui } = renderMenu({ focused: false });
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${listRowLead('default')}Apply`);
    expect(frame).not.toContain(`${listRowLead('active')}Apply`);
    expect(frame).toContain('tab back to the actions');
    expect(frame).not.toContain('⏎ confirm');
    ui.unmount();
  });

  it('takes no keys while the composer holds focus', async () => {
    const { ui, onCommand } = renderMenu({ focused: false });
    await flushEffects();
    ui.stdin.write('\r');
    await tick(30);

    expect(onCommand).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('keeps Back and the legend in view when the findings outgrow the menu', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const { ui, onCommand } = renderMenu({
      override: true,
      findings: Array.from({ length: 8 }, (_, index) => `Open finding ${index + 1} needs a fix`),
      height: 9,
    });
    await flushEffects();
    ui.stdin.write('\r');
    await tick(30);
    const asking = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(asking).toContain('Apply with 8 open findings?');
    expect(asking).toContain('- Open finding 1 needs a fix');
    expect(asking).toContain('more open findings');
    expect(asking).toContain('Back · return to the result menu');
    expect(asking).toContain('tab type a command');

    ui.stdin.write(DOWN);
    await tick(30);
    ui.stdin.write('\r');
    await tick(30);
    expect(onCommand).not.toHaveBeenCalled();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Show diff');
    ui.unmount();
  });

  it('asks once before applying an override, and goes back without applying', async () => {
    const { ui, onCommand } = renderMenu({ override: true, findings: ['missing null check'] });
    await flushEffects();
    ui.stdin.write('\r');
    await tick(30);

    expect(onCommand).not.toHaveBeenCalled();
    const asking = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(asking).toContain('Apply with 1 open finding?');
    expect(asking).toContain('missing null check');

    ui.stdin.write(DOWN);
    await tick(30);
    ui.stdin.write('\r');
    await tick(30);
    expect(onCommand).not.toHaveBeenCalled();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Show diff');

    ui.stdin.write('\r');
    await tick(30);
    ui.stdin.write('\r');
    await tick(30);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith('/run accept confirm');
    ui.unmount();
  });
  it.each([
    [false, 'accent', 'Ready to apply'],
    [true, 'warning', 'Ready to apply as is'],
  ] as const)('paints the override=%s title with %s', (override, tone, title) => {
    chalk.level = 3;
    const { ui } = renderMenu({ override, findings: ['Finding stays open'] });
    expect(ui.lastFrame()).toContain(paint(defaultTheme[tone], title).replace('\u001b[39m', ''));
    expect(ui.lastFrame()).toContain(
      paint(
        defaultTheme.textDim,
        override
          ? ' · 1 open finding · 4 files changed'
          : ' · 4 files changed · run changes await Apply',
      ),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.accent, `${listRowLead('active')}Apply`).replace('\u001b[39m', ''),
    );
    ui.unmount();
  });

  it('keeps the override confirmation warning and findings text', async () => {
    chalk.level = 3;
    const { ui } = renderMenu({ override: true, findings: ['Finding stays open'] });
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(ui.lastFrame()).toContain(paint(defaultTheme.warning, 'Apply with 1 open finding?'));
    expect(ui.lastFrame()).toContain(paint(defaultTheme.text, '- Finding stays open'));
    ui.unmount();
  });
});

import { listRowLead } from '../../../components/list-row/lead.js';
import chalk from 'chalk';
import { defaultTheme } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import type { RedCheck } from '../../../core/schemas/workflow/review-record.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { inlineMenuLayout } from '../inline-menu/layout.js';
import { UNREAD_WORDS_MESSAGE } from '../inline-menu/use-keys.js';
import { PASTE_END, PASTE_START } from '../../../lib/terminal/filtered-stdin/paste.js';
import { ResultMenu } from './menu.js';
import { resultMenuRows } from './options.js';

const originalColorLevel = chalk.level;

const DOWN = '\x1b[B';

const V1: RedCheck = { id: 'V1', command: 'npm test', lastLine: 'Error: 2 specs failed' };
const K004: RedCheck = { id: 'K004', lastLine: 'src/a.ts(3,1): TS2322' };

function renderMenu(input: Parameters<typeof menuElement>[0] = {}) {
  const menu = menuElement(input);
  return { ui: renderFeature(menu.element), ...menu };
}

function menuElement(
  input: {
    override?: boolean;
    findings?: string[];
    redChecks?: RedCheck[];
    note?: string;
    focused?: boolean;
    height?: number;
  } = {},
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
        redChecks={input.redChecks}
        note={input.note}
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
  return { element: <ControlledMenu />, onCommand, onShowDiff, onFocusChange };
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

  it('paints each line of the action holding the keys and clears its band on focus loss', () => {
    chalk.level = 3;
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    const { ui } = renderMenu();
    const band = chalk.bgHex(defaultTheme.selectionBg!)('x').split('x')[0]!;
    const frame = ui.lastFrame()?.split('\n') ?? [];
    const first = frame.findIndex((line) => stripAnsiStyles(line).includes('Apply'));
    const next = frame.findIndex((line) => stripAnsiStyles(line).includes('Show diff'));

    expect(next - first).toBeGreaterThan(1);
    for (const line of frame.slice(first, next)) expect(line).toContain(band);
    expect(frame[next]).not.toContain(band);
    ui.rerender(menuElement({ focused: false }).element);
    expect(ui.lastFrame()).not.toContain(band);
    ui.unmount();
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
        paint(defaultTheme.textDim, '  open the run’s changes').replace('\u001b[39m', ''),
      );
      await flushEffects();
      ui.stdin.write(DOWN);
      await flushEffects();
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.accent, `${listRowLead('active')}Show diff`).replace('\u001b[39m', ''),
      );
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.textDim, '  open the run’s changes').replace('\u001b[39m', ''),
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

  it('starts an unframed row on the composer text column', async () => {
    const { ui } = renderMenu({ height: 3 });
    await tick();

    expect(stripAnsiStyles(ui.lastFrame() ?? '').split('\n')[0]).toMatch(/^ {2}\S/);
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
    expect(asking).toMatch(/Back {2,}return to the result menu/);
    expect(asking).toContain('tab type a command');

    ui.stdin.write(DOWN);
    await tick(30);
    ui.stdin.write('\r');
    await tick(30);
    expect(onCommand).not.toHaveBeenCalled();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Show diff');
    ui.unmount();
  });

  it('lists the open findings under a long note at 80 and 60 columns', async () => {
    const note = Array.from(
      { length: 12 },
      (_, index) => `Reason ${index + 1}: the documented form behaviour stays as it is.`,
    ).join(' ');
    for (const { cols, rows, height, noteRows } of [
      { cols: 80, rows: 24, height: 16, noteRows: 8 },
      { cols: 60, rows: 18, height: 10, noteRows: 1 },
    ]) {
      terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 80 });
      const { ui } = renderMenu({
        override: true,
        findings: ['missing null check', 'stale doc'],
        note,
        height,
      });
      await flushEffects();
      ui.stdin.write('\r');
      await vi.waitFor(() =>
        expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Apply with 2 open findings?'),
      );
      const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
      const title = lines.findIndex((line) => line.includes('Apply with 2 open findings?'));
      const firstFinding = lines.findIndex((line) => line.includes('- missing null check'));

      expect(firstFinding - title - 1).toBe(noteRows);
      expect(lines[firstFinding - 1]).toContain('…');
      expect(lines[firstFinding + 1]).toContain('- stale doc');
      expect(lines[firstFinding + 2]).toContain('Apply as is');
      expect(lines.join('\n')).not.toContain('more open finding');
      ui.unmount();
    }
  });

  it('keeps the title in view when a finding carries a line break', async () => {
    const { ui } = renderMenu({
      override: true,
      findings: ['Edge case missing\nUnicode input is not covered', 'Criterion C1: fail'],
    });
    await flushEffects();
    ui.stdin.write('\r');
    await tick(30);
    const rows = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const title = rows.findIndex((row) => row.includes('Apply with 2 open findings?'));

    expect(title).toBeGreaterThan(-1);
    expect(rows[title + 1]).toContain('- Edge case missing Unicode input is not covered');
    expect(rows[title + 2]).toContain('- Criterion C1: fail');
    expect(rows[title + 3]).toMatch(/Apply as is {2,}write the changes/);
    ui.unmount();
  });

  it.each([
    {
      findings: ['missing null check'],
      ready: 'Ready to apply as is · 1 red check · 1 open finding · 4 files changed',
      apply:
        /Apply as is {2,}write the changes with the red checks and the open findings; asks once/,
      title: 'Apply with 1 red check and 1 open finding?',
      list: ['- V1 failed · npm test · Error: 2 specs failed', '- missing null check'],
      confirm: /Apply as is {2,}write the changes; the red checks and these findings stay open/,
    },
    {
      findings: [],
      ready: 'Ready to apply as is · 1 red check · 4 files changed',
      apply: /Apply as is {2,}write the changes with the red checks; asks once/,
      title: 'Apply with 1 red check?',
      list: ['- V1 failed · npm test · Error: 2 specs failed'],
      confirm: /Apply as is {2,}write the changes; the red checks stay red/,
    },
  ])(
    'shows the red check of an override first, then its open findings: $title',
    async ({ findings, ready, apply, title, list, confirm }) => {
      const { ui, onCommand } = renderMenu({ override: true, redChecks: [V1], findings });
      const frame = () => stripAnsiStyles(ui.lastFrame() ?? '');
      await flushEffects();
      await vi.waitFor(() => expect(frame()).toContain(ready));
      expect(frame()).toMatch(apply);

      ui.stdin.write('\r');
      await vi.waitFor(() => expect(frame()).toContain(title));
      const rows = frame().split('\n');
      const titleRow = rows.findIndex((row) => row.includes(title));
      for (const [index, line] of list.entries()) {
        expect(rows[titleRow + 1 + index]).toContain(line);
      }
      expect(rows[titleRow + 1 + list.length]).toMatch(confirm);
      expect(onCommand).not.toHaveBeenCalled();
      ui.unmount();
    },
  );

  it.each([
    {
      redChecks: [V1, K004],
      findings: [],
      spareRows: 3,
      noteRows: 1,
      title: 'Apply with 2 red checks?',
      list: [
        '- V1 failed · npm test · Error: 2 specs failed',
        '- K004 failed · src/a.ts(3,1): TS2322',
      ],
    },
    {
      redChecks: [V1, K004, { id: 'V2', command: 'npm run lint' }],
      findings: Array.from({ length: 5 }, (_, index) => `Open finding ${index + 1} needs a fix`),
      spareRows: 4,
      noteRows: 2,
      title: 'Apply with 3 red checks and 5 open findings?',
      list: [
        '- V1 failed · npm test · Error: 2 specs failed',
        '+7 more red checks and open findings',
      ],
    },
  ])(
    'shares $spareRows spare rows between a long note, the red checks and the open findings: $title',
    async ({ redChecks, findings, spareRows, noteRows, title, list }) => {
      const note = Array.from(
        { length: 12 },
        (_, index) => `Reason ${index + 1}: the documented form behaviour stays as it is.`,
      ).join(' ');
      terminalSizeStore.__testReset({ cols: 80, rows: 24 });
      const asking = { override: true, redChecks, findings, note, confirming: true, files: 4 };
      const { ui } = renderMenu({
        override: true,
        redChecks,
        findings,
        note,
        height: inlineMenuLayout(resultMenuRows(asking), 80).height + spareRows,
      });
      const frame = () => stripAnsiStyles(ui.lastFrame() ?? '');
      await flushEffects();
      ui.stdin.write('\r');
      await vi.waitFor(() => expect(frame()).toContain(title));
      const rows = frame().split('\n');
      const titleRow = rows.findIndex((row) => row.includes(title));
      const firstOpen = rows.findIndex((row) => row.includes(list[0] ?? ''));

      expect(firstOpen - titleRow - 1).toBe(noteRows);
      expect(rows[firstOpen - 1]).toContain('…');
      for (const [index, line] of list.entries()) {
        expect(rows[firstOpen + index]).toContain(line);
      }
      expect(rows[firstOpen + list.length]).toMatch(/Apply as is {2,}write the changes/);
      expect(frame()).toMatch(/Back {2,}return to the result menu/);
      expect(frame()).toContain('tab type a command');
      ui.unmount();
    },
  );

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

  // A word names no row: the ⏎ of the same read takes no action and says how to choose one.
  it('takes no action on discard and ⏎ in one read, and applies on the ⏎ after it', async () => {
    const menu = menuElement();
    const ui = renderThroughFilteredStdin(menu.element);
    try {
      await ui.settled();
      ui.pressBytes('discard\r');
      await ui.settled();
      expect(menu.onCommand).not.toHaveBeenCalled();
      expect(feedbackStore.get().message).toBe(UNREAD_WORDS_MESSAGE);

      ui.pressBytes('\r');
      await ui.settled();
      expect(menu.onCommand).toHaveBeenCalledExactlyOnceWith('/run accept');
    } finally {
      ui.unmount();
    }
  });

  // The rows of this menu have no letter keys, so each typed letter names no row.
  it('takes no action on discard typed one key per read and ⏎, and applies on the ⏎ after it', async () => {
    const menu = menuElement();
    const ui = renderThroughFilteredStdin(menu.element);
    try {
      await ui.settled();
      for (const letter of 'discard') {
        ui.pressBytes(letter);
        await ui.settled();
      }
      ui.pressBytes('\r');
      await ui.settled();
      expect(menu.onCommand).not.toHaveBeenCalled();
      expect(feedbackStore.get().message).toBe(UNREAD_WORDS_MESSAGE);

      ui.pressBytes('\r');
      await ui.settled();
      expect(menu.onCommand).toHaveBeenCalledExactlyOnceWith('/run accept');
    } finally {
      ui.unmount();
    }
  });

  it('takes no action on a bracketed paste of discard and ⏎, and says how to choose one', async () => {
    const menu = menuElement();
    const ui = renderThroughFilteredStdin(menu.element);
    try {
      await ui.settled();
      ui.pressBytes(`${PASTE_START}discard${PASTE_END}`);
      await ui.settled();
      ui.pressBytes('\r');
      await ui.settled();
      expect(menu.onCommand).not.toHaveBeenCalled();
      expect(feedbackStore.get().message).toBe(UNREAD_WORDS_MESSAGE);
    } finally {
      ui.unmount();
    }
  });
});

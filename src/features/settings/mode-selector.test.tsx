import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { SOFT_SEP } from '../../components/separators.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { getWorkflowMode } from '../../core/config/accessors/values.js';
import { ModeSelector } from './mode-selector.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { glyph } from '../../lib/glyphs.js';

const envSnapshot = { ...process.env };

function modeLine(frame: string, mode: string): string {
  return (
    stripAnsiStyles(frame)
      .split('\n')
      .find((line) => line.includes(mode)) ?? ''
  );
}

describe('ModeSelector', () => {
  let projectDir = '';

  beforeEach(() => {
    projectDir = createTempDir('mode-selector-test');
    configStore.__testReset({ projectDir, config: makeConfig() });
    overlayStore.reset();
    feedbackStore.reset();
    terminalSizeStore.reset();
    _resetMouseZones();
  });

  afterEach(() => {
    configStore.reset();
    overlayStore.reset();
    feedbackStore.reset();
    terminalSizeStore.reset();
    _resetMouseZones();
    if (projectDir) cleanupTempDir(projectDir);
    projectDir = '';
    process.env = { ...envSnapshot };
  });

  it('renders exactly the three workflow modes and never instant', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Workflow mode');
    expect(frame).not.toContain('instant');
    expect([...collectClickableZones({ cols: 120, rows: 40 }).keys()]).toEqual([
      'mode:quick',
      'mode:standard',
      'mode:speckit',
    ]);

    ui.unmount();
  });

  it('counts derive from mode table', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(`↑↓ navigate${SOFT_SEP}⏎ confirm${SOFT_SEP}esc close`);
    // The counts sit on the line under each row, so they are read from the panel, not the row.
    expect(frame).toContain(`1 planning call${SOFT_SEP}0 gates`);
    expect(frame).toContain(`4 planning calls${SOFT_SEP}2 gates (spec + briefs)`);
    expect(frame).toContain(`6-7 planning calls${SOFT_SEP}3 gates (spec + plan + briefs)`);

    ui.unmount();
  });

  it('the counts line starts in the metadata column of the row above it', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(modeLine(frame, 'plan and go').indexOf('plan and go')).toBe(
      modeLine(frame, '1 planning call').indexOf('1 planning call'),
    );

    ui.unmount();
  });

  it('label and metadata columns start at identical x on every row at 80 cols including speckit', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: true });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const modeCases: ReadonlyArray<readonly [string, string]> = [
      ['quick', '1 planning'],
      ['standard', '4 planning'],
      ['speckit', '6-7 planning'],
    ];
    const metadataStarts = modeCases.map(([mode, metadata]) => {
      const line = modeLine(frame, mode);
      expect(line).toContain(metadata);
      return line.indexOf(metadata);
    });

    expect(new Set(metadataStarts).size).toBe(1);
    ui.unmount();
  });

  it('a one-line row carries its counts whole and keeps a column before the check', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const wholeCounts: ReadonlyArray<readonly [string, string]> = [
      ['quick', '1 planning call · 0 gates'],
      ['standard', '4 planning calls · 2 gates'],
      ['speckit', '6-7 planning calls · 3 gates'],
    ];
    for (const [mode, counts] of wholeCounts) {
      const line = modeLine(frame, mode);
      expect(line).toContain(counts);
      expect(line).not.toContain('…');
      expect(line).not.toContain('(');
    }
    const currentLine = modeLine(frame, 'standard');
    const checkAt = currentLine.indexOf(glyph('check'));
    expect(currentLine.slice(checkAt - 2, checkAt)).toBe('  ');

    ui.unmount();
  });

  it('overflowing metadata truncates with …', async () => {
    terminalSizeStore.__testReset({ cols: 50, rows: 30, isSmall: true });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    expect(modeLine(ui.lastFrame() ?? '', 'speckit')).toContain('…');
    ui.unmount();
  });

  it('✓ Current renders only on the current row without shifting its metadata start', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const currentLine = modeLine(frame, 'standard');
    const otherLine = modeLine(frame, 'quick');

    expect(currentLine).toContain(`${glyph('check')} Current`);
    expect(currentLine.split('Current').length - 1).toBe(1);
    expect(otherLine).not.toContain('Current');
    expect(currentLine.indexOf('spec gate')).toBe(otherLine.indexOf('plan and go'));
    ui.unmount();
  });

  it('clicking a mode row saves that mode, sets feedback, and closes the overlay', async () => {
    overlayStore.open('mode-selector');
    expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('standard');

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const click = collectClickableZones({ cols: 100, rows: 50 }).get('mode:quick');
    expect(click).toBeDefined();
    click?.();
    await vi.waitFor(() => {
      expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('quick');
    });
    expect(feedbackStore.get().message).toContain('quick');
    expect(overlayStore.get().active).toBe('none');

    ui.unmount();
  });

  it('does not save a hidden workflow mode on Enter when no mode row is visible', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 4, isSmall: false });
    overlayStore.open('mode-selector');
    expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('standard');

    const ui = renderFeature(<ModeSelector />);
    await flushEffects();

    ui.stdin.write('\u001b[B');
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('standard');
    expect(overlayStore.get().active).toBe('mode-selector');

    ui.unmount();
  });

  it('clicking a hidden mode row does not save when the row is not rendered', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 4, isSmall: false });
    overlayStore.open('mode-selector');

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    collectClickableZones({ cols: 80, rows: 4 }).get('mode:quick')?.();
    await tick(20);

    expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('standard');
    ui.unmount();
  });

  it('uses the ascii check mark for the current mode in the ascii tier', async () => {
    process.env.TERM = 'dumb';
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(`${glyph('check', 'ascii')} Current`);
    expect(frame).not.toContain('✓ Current');
    ui.unmount();
  });
});

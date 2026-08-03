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

  it('renders planner call counts that match current workflow mode semantics', async () => {
    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Workflow mode');
    expect(frame).toContain(`↑↓ navigate${SOFT_SEP}⏎ confirm${SOFT_SEP}esc close`);
    expect(frame).toContain('instant');
    expect(frame).toContain('1 call');
    expect(frame).toContain('standard');
    expect(frame).toContain('4 calls');
    expect(frame).toContain('speckit');
    expect(frame).toContain('6-7 calls');

    ui.unmount();
  });

  it('label and metadata columns start at identical x on every row at 80 cols including speckit', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: true });

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const modeCases: ReadonlyArray<readonly [string, string]> = [
      ['instant', '1 call'],
      ['quick', '1 call'],
      ['standard', '4 calls'],
      ['speckit', '6-7 calls'],
    ];
    const metadataStarts = modeCases.map(([mode, metadata]) => {
      const line = modeLine(frame, mode);
      expect(line).toContain(metadata);
      return line.indexOf(metadata);
    });

    expect(new Set(metadataStarts).size).toBe(1);
    ui.unmount();
  });

  it('overflowing metadata truncates with …', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: true });

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
    const otherLine = modeLine(frame, 'instant');

    expect(currentLine).toContain(`${glyph('check')} Current`);
    expect(currentLine.split('Current').length - 1).toBe(1);
    expect(otherLine).not.toContain('Current');
    expect(currentLine.indexOf('4 calls')).toBe(otherLine.indexOf('1 call'));
    ui.unmount();
  });

  it('clicking a mode row saves that mode, sets feedback, and closes the overlay', async () => {
    overlayStore.open('mode-selector');
    expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('standard');

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    const click = collectClickableZones({ cols: 100, rows: 50 }).get('mode:instant');
    expect(click).toBeDefined();
    click?.();
    await vi.waitFor(() => {
      expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('instant');
    });
    expect(feedbackStore.get().message).toContain('instant');
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

    collectClickableZones({ cols: 80, rows: 4 }).get('mode:instant')?.();
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

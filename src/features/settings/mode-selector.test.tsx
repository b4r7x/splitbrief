import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { getWorkflowMode } from '../../core/config/accessors/values.js';
import { ModeSelector } from './mode-selector.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { glyph } from '../../lib/glyphs.js';

const envSnapshot = { ...process.env };

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
    expect(frame).toContain('instant');
    expect(frame).toContain('1 call');
    expect(frame).toContain('standard');
    expect(frame).toContain('4 calls');
    expect(frame).toContain('speckit');
    expect(frame).toContain('6-7 calls');

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
    await tick(20);

    expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('instant');
    expect(feedbackStore.get().message).toContain('instant');
    expect(overlayStore.get().active).toBe('none');

    ui.unmount();
  });

  it('does not save a hidden workflow mode on Enter when no mode row is visible', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 4, isSmall: false });
    overlayStore.open('mode-selector');
    expect(getWorkflowMode(configStore.get().config ?? makeConfig())).toBe('standard');

    const ui = renderFeature(<ModeSelector />);
    await tick(20);

    ui.stdin.write('\u001b[B');
    await tick(20);
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
    expect(frame).toContain(`${glyph('check', 'ascii')} current`);
    expect(frame).not.toContain('✓ current');
    ui.unmount();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { SettingsOverlay } from '../../../src/app/overlays/settings.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { configStore } from '../../../src/stores/project/config.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { _resetMouseZones } from '../../../src/lib/terminal/mouse-zones.js';

const PAGE_DOWN = '\u001b[6~';
const CURSOR_GLYPH = '▌';

function lineContaining(frame: string, text: string): string {
  const line = frame.split('\n').find((candidate) => candidate.includes(text));
  expect(line).toBeDefined();
  return line ?? '';
}

describe('settings overlay integration', () => {
  let dir: string;

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    dir = createTempDir('diptych-settings-it');
    configStore.load(dir);
    overlayStore.open('settings');
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  it('space toggles a boolean field and saves to disk', async () => {
    expect(configStore.get().config?.validation.typecheck).toBe(true);

    overlayStore.open('settings', 'validation.typecheck');
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);
    expect(ui.lastFrame()).toContain('Type Check');

    ui.stdin.write(' ');
    await tick(20);

    expect(loadConfig(dir).config.validation.typecheck).toBe(false);
    ui.unmount();
  });

  it('clicking a boolean row toggles it and saves (alternate trigger)', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    expect(configStore.get().config?.validation.typecheck).toBe(true);

    overlayStore.open('settings', 'validation.typecheck');
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);
    expect(ui.lastFrame()).toContain('Type Check');

    collectClickableZones({ cols: 100, rows: 50 }).get('list-row:validation.typecheck')?.();
    await tick(20);

    expect(loadConfig(dir).config.validation.typecheck).toBe(false);
    ui.unmount();
  });

  it('typing edits a number, Enter commits via validation', async () => {
    overlayStore.open('settings', 'workflow.maxRetries');
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);
    expect(ui.lastFrame()).toContain('Max Retries');

    ui.stdin.write('\r'); // Enter edit mode on the numeric field.
    await tick(40);
    const editingFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(editingFrame).toContain('Max Retries'); // the field row is rendered
    expect(editingFrame).toContain('3'); // seeded value shown in the edit buffer

    ui.stdin.write('\x7f'); // backspace — clear seeded "3"
    await tick(40);
    const clearedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(clearedFrame).toContain('Max Retries');
    expect(clearedFrame).not.toContain('3'); // buffer cleared, no value digit shown

    ui.stdin.write('5');
    await tick(40);
    const typedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(typedFrame).toContain('Max Retries');
    expect(typedFrame).toContain('5'); // typed value shown in the edit buffer

    ui.stdin.write('\r'); // commit
    await tick(20);

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.workflow.maxRetries).toBe(5);
    });
    ui.unmount();
  });

  it('keeps edit mode open and surfaces an error when committing invalid input', async () => {
    overlayStore.open('settings', 'workflow.maxRetries');
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);

    ui.stdin.write('\r'); // enter edit mode (seeded "3")
    await tick(40);
    ui.stdin.write('\x7f'); // backspace — clear seeded value
    await tick(40);
    ui.stdin.write('9');
    ui.stdin.write('9'); // "99" is above max (10)
    await tick(40);

    ui.stdin.write('\r'); // attempt commit of out-of-range value
    await tick(40);

    // Edit mode stays open: the buffer is still shown with its cursor marker.
    expect(ui.lastFrame() ?? '').toContain('[99▏]');
    // The invalid value was NOT persisted.
    expect(loadConfig(dir).config.workflow.maxRetries).toBe(3);
    // A feedback error was surfaced.
    const feedback = feedbackStore.get();
    expect(feedback.isError).toBe(true);
    expect(feedback.message).toContain('Max Retries');

    ui.unmount();
  });

  it('Esc cancels an active edit without saving', async () => {
    overlayStore.open('settings', 'workflow.maxRetries');
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);
    expect(ui.lastFrame()).toContain('Max Retries');

    ui.stdin.write('\r');
    await tick(20);
    ui.stdin.write('\x7f');
    await tick(20);
    ui.stdin.write('9');
    await tick(20);
    ui.stdin.write('\x1b'); // escape
    await tick(20);

    expect(loadConfig(dir).config.workflow.maxRetries).toBe(3);
    ui.unmount();
  });

  it('PageDown moves by visible selectable settings without skipping a section', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    overlayStore.open('settings', 'planner.kind');
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);

    ui.stdin.write(PAGE_DOWN);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Validation');
    expect(lineContaining(frame, CURSOR_GLYPH)).toContain('Type Check');
    ui.unmount();
  });

  it('does not show a false more row when sectioned settings fit', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 60, isSmall: false });
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Planner');
    expect(frame).toContain('Validation');
    expect(frame).not.toContain('more');
    ui.unmount();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsOverlay } from './overlay.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { loadConfig } from '../../core/config/load/io.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { CURSOR } from '../../components/pickers/cursor-glyph.js';

const PAGE_DOWN = '\u001b[6~';
const CURSOR_GLYPH = CURSOR.trimEnd();

function lineContaining(frame: string, text: string): string {
  const line = frame.split('\n').find((candidate) => candidate.includes(text));
  expect(line).toBeDefined();
  return line ?? '';
}

describe('settings overlay integration', () => {
  let dir: string;

  beforeEach(() => {
    resetAllStores();
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

  it('typing edits a number, Enter commits via validation', async () => {
    overlayStore.open('settings', 'workflow.maxRetries');
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);
    expect(ui.lastFrame()).toContain('Max Retries');

    ui.stdin.write('\r'); // Enter edit mode on the numeric field.
    await tick(40);
    const editingFrame = ui.lastFrame() ?? '';
    expect(editingFrame).toContain('Max Retries'); // the field row is rendered
    expect(editingFrame).toContain('3'); // seeded value shown in the edit buffer

    ui.stdin.write('\x7f'); // backspace — clear seeded "3"
    await tick(40);
    const clearedFrame = ui.lastFrame() ?? '';
    expect(clearedFrame).toContain('Max Retries');
    expect(clearedFrame).not.toContain('3'); // buffer cleared, no value digit shown

    ui.stdin.write('5');
    await tick(40);
    const typedFrame = ui.lastFrame() ?? '';
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
    expect(ui.lastFrame() ?? '').toContain('[99|]');
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
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
const ARROW_DOWN = '\u001b[B';
const CURSOR_GLYPH = '▌';
const KITTY_SUPER_SPACE = '\u001b[32;9u';
const KITTY_HYPER_SPACE = '\u001b[32;17u';

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
    dir = createTempDir('splitbrief-settings-it');
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
    await flushEffects();
    expect(ui.lastFrame()).toContain('Type check');

    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.validation.typecheck).toBe(false);
    });

    ui.unmount();
  });

  it('applies queued Down before Space and toggles the new logical selection', async () => {
    expect(configStore.get().config?.validation.typecheck).toBe(true);
    expect(configStore.get().config?.validation.lint).toBe(true);

    overlayStore.open('settings', 'validation.typecheck');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      const validation = loadConfig(dir).config.validation;
      expect(validation.typecheck).toBe(true);
      expect(validation.lint).toBe(false);
    });

    ui.unmount();
  });

  it('applies rapid boolean toggles sequentially against the latest config', async () => {
    overlayStore.open('settings', 'validation.typecheck');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(' ');
    ui.stdin.write(' ');
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.validation.typecheck).toBe(false);
    });

    ui.stdin.write(' ');
    ui.stdin.write(ARROW_DOWN);
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      const validation = loadConfig(dir).config.validation;
      expect(validation.typecheck).toBe(true);
      expect(validation.lint).toBe(false);
    });
    ui.unmount();
  });

  it('does not toggle settings on modified Space input', async () => {
    overlayStore.open('settings', 'validation.typecheck');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(KITTY_SUPER_SPACE);
    ui.stdin.write(KITTY_HYPER_SPACE);
    await flushEffects();

    expect(loadConfig(dir).config.validation.typecheck).toBe(true);
    ui.unmount();
  });

  it('advances an enum twice from the latest saved value', async () => {
    overlayStore.open('settings', 'workflow.mode');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(' ');
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.workflow.mode).toBe('quick');
    });

    ui.unmount();
  });

  it('clicking a boolean row toggles it and saves (alternate trigger)', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    expect(configStore.get().config?.validation.typecheck).toBe(true);

    overlayStore.open('settings', 'validation.typecheck');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('Type check');

    collectClickableZones({ cols: 100, rows: 50 }).get('list-row:validation.typecheck')?.();
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.validation.typecheck).toBe(false);
    });

    ui.unmount();
  });

  it('typing edits a number, Enter commits via validation', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 60, isSmall: false });
    overlayStore.open('settings', 'workflow.maxRetries');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('Max retries');

    ui.stdin.write('\r'); // Enter edit mode on the numeric field.
    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(true);
    });
    await flushEffects();

    ui.stdin.write('\x7f'); // backspace — clear seeded "3"
    await vi.waitFor(() => {
      const clearedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(clearedFrame, 'Max retries')).not.toContain('3');
    });
    await flushEffects();

    ui.stdin.write('5');
    await vi.waitFor(() => {
      const typedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(typedFrame, 'Max retries')).toContain('5');
    });
    await flushEffects();

    ui.stdin.write('\r'); // commit

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.workflow.maxRetries).toBe(5);
    });

    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(false);
      expect(feedbackStore.get().isError).toBe(false);
    });

    ui.unmount();
  });

  it('keeps edit mode open and surfaces an error when committing invalid input', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 60, isSmall: false });
    overlayStore.open('settings', 'workflow.maxRetries');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write('\r'); // enter edit mode (seeded "3")
    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(true);
    });

    await flushEffects();
    ui.stdin.write('\x7f');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Max retries')).not.toContain('3');
    });
    await flushEffects();

    ui.stdin.write('9');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Max retries')).toContain('9');
    });
    await flushEffects();

    ui.stdin.write('9'); // "99" is above max (10)
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Max retries')).toContain('99');
    });
    await flushEffects();

    ui.stdin.write('\r'); // attempt commit of out-of-range value

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.workflow.maxRetries).toBe(3);
      const feedback = feedbackStore.get();
      expect(feedback.isError).toBe(true);
      expect(feedback.message).toContain('Max retries');
      expect(overlayStore.get().exclusive).toBe(true);
    });
    await flushEffects();

    ui.stdin.write('\x7f');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      const maxRetriesLine = lineContaining(frame, 'Max retries');
      expect(maxRetriesLine).toContain('9');
      expect(maxRetriesLine).not.toContain('99');
    });
    await flushEffects();

    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.workflow.maxRetries).toBe(9);
      expect(overlayStore.get().exclusive).toBe(false);
      expect(feedbackStore.get().isError).toBe(false);
    });

    ui.unmount();
  });

  it('Esc cancels an active edit without saving', async () => {
    overlayStore.open('settings', 'workflow.maxRetries');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('Max retries');

    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('\x7f');
    await flushEffects();
    ui.stdin.write('9');
    await flushEffects();
    ui.stdin.write('\x1b'); // escape

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.workflow.maxRetries).toBe(3);
    });
    ui.unmount();
  });

  it('PageDown moves by visible selectable settings without skipping a section', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    overlayStore.open('settings', 'implementer.temperature');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(lineContaining(stripAnsiStyles(ui.lastFrame() ?? ''), CURSOR_GLYPH)).toContain(
      'Temperature',
    );

    ui.stdin.write(PAGE_DOWN);
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, CURSOR_GLYPH)).toContain('Spec/plan gates');
      expect(frame).toContain('Max retries');
    });
    ui.unmount();
  });

  it('does not show a false more row when sectioned settings fit', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 60, isSmall: false });
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Tuning');
    expect(frame).toContain('Validation');
    expect(frame).not.toContain('more');
    ui.unmount();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { SettingsOverlay } from '../../../src/app/overlays/settings.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { configStore } from '../../../src/stores/project/config.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { _resetMouseZones } from '../../../src/lib/terminal/mouse-zones.js';

const PAGE_DOWN = '\u001b[6~';
const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const CURSOR_GLYPH = '▌';
const KITTY_SUPER_SPACE = '\u001b[32;9u';
const KITTY_HYPER_SPACE = '\u001b[32;17u';
const SEEDED_TIMEOUT_MS = 240_000;

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
    expect(configStore.get().config?.validation.endChecks).toBe(true);

    overlayStore.open('settings', 'validation.endChecks');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('End-of-run checks');

    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.validation.endChecks).toBe(false);
    });
    await vi.waitFor(() => {
      expect(lineContaining(stripAnsiStyles(ui.lastFrame() ?? ''), 'Saved')).toContain(
        'Saved End-of-run checks · off to .splitbrief/config.yaml',
      );
    });

    ui.unmount();
  });

  it('applies queued Down before Space and toggles the new logical selection', async () => {
    const isolation = loadConfig(dir).config.workflow.isolation;
    expect(configStore.get().config?.validation.endChecks).toBe(true);

    overlayStore.open('settings', 'workflow.isolation');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      const config = loadConfig(dir).config;
      expect(config.workflow.isolation).toBe(isolation);
      expect(config.validation.endChecks).toBe(false);
    });

    ui.unmount();
  });

  it('applies rapid boolean toggles sequentially against the latest config', async () => {
    overlayStore.open('settings', 'validation.endChecks');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(' ');
    ui.stdin.write(' ');
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.validation.endChecks).toBe(false);
    });

    // Back on, then up past Isolation to Create branch, which turns on.
    ui.stdin.write(' ');
    ui.stdin.write(ARROW_UP);
    ui.stdin.write(ARROW_UP);
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      const config = loadConfig(dir).config;
      expect(config.validation.endChecks).toBe(true);
      expect(config.workflow.git?.createBranch).toBe(true);
    });
    ui.unmount();
  });

  it('does not toggle settings on modified Space input', async () => {
    overlayStore.open('settings', 'validation.endChecks');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(KITTY_SUPER_SPACE);
    ui.stdin.write(KITTY_HYPER_SPACE);
    await flushEffects();

    expect(loadConfig(dir).config.validation.endChecks).toBe(true);
    ui.unmount();
  });

  it('advances an enum twice from the latest saved value', async () => {
    overlayStore.open('settings', 'workflow.compactionFormat');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(' ');
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.workflow.compactionFormat).toBe('structured');
    });

    ui.unmount();
  });

  it('clicking a boolean row toggles it and saves (alternate trigger)', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    expect(configStore.get().config?.validation.endChecks).toBe(true);

    overlayStore.open('settings', 'validation.endChecks');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('End-of-run checks');

    collectClickableZones({ cols: 100, rows: 50 }).get('list-row:validation.endChecks')?.();
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.validation.endChecks).toBe(false);
    });

    ui.unmount();
  });

  it('typing edits a number, Enter commits via validation', async () => {
    writeConfigYaml(dir, { implementer: { timeout: SEEDED_TIMEOUT_MS } });
    configStore.load(dir);
    terminalSizeStore.__testReset({ cols: 100, rows: 60, isSmall: false });
    overlayStore.open('settings', 'implementer.timeout');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('Timeout');

    ui.stdin.write('\r'); // Enter edit mode on the numeric field.
    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(true);
    });
    await flushEffects();

    for (let i = 0; i < String(SEEDED_TIMEOUT_MS).length; i++) ui.stdin.write('\x7f');
    await vi.waitFor(() => {
      const clearedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(clearedFrame, 'Timeout')).not.toContain(String(SEEDED_TIMEOUT_MS));
    });
    await flushEffects();

    ui.stdin.write('5');
    await vi.waitFor(() => {
      const typedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(typedFrame, 'Timeout')).toContain('5');
    });
    await flushEffects();

    ui.stdin.write('\r'); // commit

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.implementer).toMatchObject({ timeout: 5 });
    });

    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(false);
      expect(feedbackStore.get().isError).toBe(false);
    });

    ui.unmount();
  });

  it('keeps edit mode open and surfaces an error when committing invalid input', async () => {
    writeConfigYaml(dir, { implementer: { timeout: SEEDED_TIMEOUT_MS } });
    configStore.load(dir);
    terminalSizeStore.__testReset({ cols: 100, rows: 60, isSmall: false });
    overlayStore.open('settings', 'implementer.timeout');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write('\r'); // enter edit mode (seeded with the configured timeout)
    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(true);
    });

    await flushEffects();
    for (let i = 0; i < String(SEEDED_TIMEOUT_MS).length; i++) ui.stdin.write('\x7f');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Timeout')).not.toContain(String(SEEDED_TIMEOUT_MS));
    });
    await flushEffects();

    ui.stdin.write('0'); // below min (1)
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Timeout')).toContain('0');
    });
    await flushEffects();

    ui.stdin.write('\r'); // attempt commit of out-of-range value

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.implementer).toMatchObject({ timeout: SEEDED_TIMEOUT_MS });
      const feedback = feedbackStore.get();
      expect(feedback.isError).toBe(true);
      expect(feedback.message).toContain('Timeout');
      expect(overlayStore.get().exclusive).toBe(true);
    });
    await flushEffects();

    ui.stdin.write('\x7f');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Timeout')).not.toContain('0');
    });
    await flushEffects();

    ui.stdin.write('5');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Timeout')).toContain('5');
    });
    await flushEffects();

    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.implementer).toMatchObject({ timeout: 5 });
      expect(overlayStore.get().exclusive).toBe(false);
      expect(feedbackStore.get().isError).toBe(false);
    });

    ui.unmount();
  });

  it('Esc cancels an active edit without saving', async () => {
    writeConfigYaml(dir, { implementer: { timeout: SEEDED_TIMEOUT_MS } });
    configStore.load(dir);
    overlayStore.open('settings', 'implementer.timeout');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('Timeout');

    ui.stdin.write('\r');
    await flushEffects();
    for (let i = 0; i < String(SEEDED_TIMEOUT_MS).length; i++) ui.stdin.write('\x7f');
    await flushEffects();
    ui.stdin.write('5');
    await flushEffects();
    ui.stdin.write('\x1b'); // escape

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.implementer).toMatchObject({ timeout: SEEDED_TIMEOUT_MS });
    });
    ui.unmount();
  });

  it('PageDown moves by visible selectable settings without skipping a section', async () => {
    // Tall enough to seat the whole Workflow section, which the page has to bring on screen.
    terminalSizeStore.__testReset({ cols: 100, rows: 26, isSmall: false });
    overlayStore.open('settings', 'implementer.temperature');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(lineContaining(stripAnsiStyles(ui.lastFrame() ?? ''), CURSOR_GLYPH)).toContain(
      'Temperature',
    );

    ui.stdin.write(PAGE_DOWN);
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, CURSOR_GLYPH)).toContain('End-of-run checks');
      // The page steps over the Workflow section and lands with the whole of it on screen — its
      // first row included — so no row was stepped over unseen.
      expect(frame).toContain('Plan approval');
      expect(frame).toContain('Isolation');
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

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
const SEEDED_CONTEXT_LENGTH = 240_000;

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
    expect(ui.lastFrame()).toContain('runs the end-of-run checks');

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
    const review = loadConfig(dir).config.workflow.review;
    expect(configStore.get().config?.validation.endChecks).toBe(true);

    overlayStore.open('settings', 'workflow.review');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      const config = loadConfig(dir).config;
      expect(config.workflow.review).toBe(review);
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

    // Back on, then up to Review cadence, which moves to task.
    ui.stdin.write(' ');
    ui.stdin.write(ARROW_UP);
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      const config = loadConfig(dir).config;
      expect(config.validation.endChecks).toBe(true);
      expect(config.workflow.review).toBe('task');
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
    overlayStore.open('settings', 'workflow.isolation');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write(' ');
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(loadConfig(dir).config.workflow.isolation).toBe('none');
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
    writeConfigYaml(dir, { implementer: { contextLength: SEEDED_CONTEXT_LENGTH } });
    configStore.load(dir);
    terminalSizeStore.__testReset({ cols: 100, rows: 60, isSmall: false });
    overlayStore.open('settings', 'implementer.contextLength');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('Context length');

    ui.stdin.write('\r'); // Enter edit mode on the numeric field.
    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(true);
    });
    await flushEffects();

    for (let i = 0; i < String(SEEDED_CONTEXT_LENGTH).length; i++) ui.stdin.write('\x7f');
    await vi.waitFor(() => {
      const clearedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(clearedFrame, 'Context length')).not.toContain(
        String(SEEDED_CONTEXT_LENGTH),
      );
    });
    await flushEffects();

    ui.stdin.write('4096');
    await vi.waitFor(() => {
      const typedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(typedFrame, 'Context length')).toContain('4096');
    });
    await flushEffects();

    ui.stdin.write('\r'); // commit

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.implementer).toMatchObject({ contextLength: 4096 });
    });

    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(false);
      expect(feedbackStore.get().severity).toBe('info');
    });

    ui.unmount();
  });

  it('keeps edit mode open and shows a neutral note when committing invalid input', async () => {
    writeConfigYaml(dir, { implementer: { contextLength: SEEDED_CONTEXT_LENGTH } });
    configStore.load(dir);
    terminalSizeStore.__testReset({ cols: 100, rows: 60, isSmall: false });
    overlayStore.open('settings', 'implementer.contextLength');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();

    ui.stdin.write('\r'); // enter edit mode (seeded with the configured context length)
    await vi.waitFor(() => {
      expect(overlayStore.get().exclusive).toBe(true);
    });

    await flushEffects();
    for (let i = 0; i < String(SEEDED_CONTEXT_LENGTH).length; i++) ui.stdin.write('\x7f');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Context length')).not.toContain(String(SEEDED_CONTEXT_LENGTH));
    });
    await flushEffects();

    ui.stdin.write('0'); // below the minimum
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Context length')).toContain('0');
    });
    await flushEffects();

    ui.stdin.write('\r'); // attempt commit of out-of-range value

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.implementer).toMatchObject({
        contextLength: SEEDED_CONTEXT_LENGTH,
      });
      const feedback = feedbackStore.get();
      expect(feedback.severity).toBe('info');
      expect(feedback.message).toContain('Context length');
      expect(overlayStore.get().exclusive).toBe(true);
    });
    await flushEffects();

    ui.stdin.write('\x7f');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Context length')).not.toContain('0');
    });
    await flushEffects();

    ui.stdin.write('4096');
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, 'Context length')).toContain('4096');
    });
    await flushEffects();

    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.implementer).toMatchObject({ contextLength: 4096 });
      expect(overlayStore.get().exclusive).toBe(false);
      expect(feedbackStore.get().severity).toBe('info');
    });

    ui.unmount();
  });

  it('Esc cancels an active edit without saving', async () => {
    writeConfigYaml(dir, { implementer: { contextLength: SEEDED_CONTEXT_LENGTH } });
    configStore.load(dir);
    overlayStore.open('settings', 'implementer.contextLength');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('Context length');

    ui.stdin.write('\r');
    await flushEffects();
    for (let i = 0; i < String(SEEDED_CONTEXT_LENGTH).length; i++) ui.stdin.write('\x7f');
    await flushEffects();
    ui.stdin.write('4096');
    await flushEffects();
    ui.stdin.write('\x1b'); // escape

    await vi.waitFor(() => {
      expect(loadConfig(dir).config.implementer).toMatchObject({
        contextLength: SEEDED_CONTEXT_LENGTH,
      });
    });
    ui.unmount();
  });

  it('PageDown moves by visible selectable settings without skipping a section', async () => {
    // Tall enough to seat the whole Workflow section, which the page has to bring on screen.
    terminalSizeStore.__testReset({ cols: 100, rows: 26, isSmall: false });
    writeConfigYaml(dir, {
      implementer: {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen3-coder:30b',
      },
    });
    configStore.load(dir);
    overlayStore.open('settings', 'implementer.contextLength');
    const ui = renderFeature(<SettingsOverlay />);
    await flushEffects();
    expect(lineContaining(stripAnsiStyles(ui.lastFrame() ?? ''), CURSOR_GLYPH)).toContain(
      'Context length',
    );

    ui.stdin.write(PAGE_DOWN);
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(lineContaining(frame, CURSOR_GLYPH)).toContain('Test command');
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

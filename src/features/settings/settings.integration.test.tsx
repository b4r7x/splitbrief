import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsOverlay } from './overlay.js';
import { renderFeature, tick } from '../../../testing/helpers/ink.js';
import { resetAllStores } from '../../../testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '../../../testing/helpers/temp-dir.js';
import { loadConfig } from '../../core/config/load/load.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';

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
});

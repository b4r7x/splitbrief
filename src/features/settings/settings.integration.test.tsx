import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsOverlay } from './overlay.js';
import { renderFeature, tick } from '../../../testing/helpers/ink.js';
import { resetAllStores } from '../../../testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '../../../testing/helpers/temp-dir.js';
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

    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);
    // Filter narrows to validation.typecheck (label "Type Check").
    ui.stdin.write('type c');
    await tick(20);
    ui.stdin.write(' ');
    await tick(20);

    expect(configStore.get().config?.validation.typecheck).toBe(false);
    ui.unmount();
  });

  it('typing edits a number, Enter commits via validation', async () => {
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);

    ui.stdin.write('max retries');
    await tick(20);
    ui.stdin.write('\r'); // Enter edit mode on the numeric field.
    await tick(20);
    ui.stdin.write('\x7f'); // backspace — clear seeded "3"
    await tick(20);
    ui.stdin.write('5');
    await tick(20);
    ui.stdin.write('\r'); // commit
    await tick(20);

    expect(configStore.get().config?.workflow.maxRetries).toBe(5);
    ui.unmount();
  });

  it('Esc cancels an active edit without saving', async () => {
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);

    ui.stdin.write('max retries');
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);
    ui.stdin.write('\x7f');
    await tick(20);
    ui.stdin.write('9');
    await tick(20);
    ui.stdin.write('\x1b'); // escape
    await tick(20);

    expect(configStore.get().config?.workflow.maxRetries).toBe(3);
    ui.unmount();
  });
});

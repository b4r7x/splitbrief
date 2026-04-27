import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { useAppKeys } from './use-app-keys.js';
import { renderFeature, tick } from '../../testing/helpers/ink.js';
import { resetAllStores } from '../../testing/helpers/stores.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore, _lifecycleInternal } from '../stores/workflow/lifecycle.js';
import { abortStore } from '../stores/workflow/abort.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { setAbortHandler, clearAllHandlers } from '../features/workflow/handlers.js';

function Harness({ exit }: { exit: () => void }) {
  useAppKeys({ exit });
  return (
    <Box>
      <Text>ready</Text>
    </Box>
  );
}

function writeCtrlC(ui: { stdin: { write: (d: string) => void } }) {
  ui.stdin.write('\x03');
}

describe('useAppKeys: Ctrl+C double-press abort flow', () => {
  beforeEach(() => {
    resetAllStores();
    clearAllHandlers();
    // Simulate an active workflow turn so the first Ctrl+C arms the abort.
    routerStore.navigate({ to: 'workflow', feature: 'test' });
    _lifecycleInternal.set({ phase: 'implementing', cancelled: false, queueDepth: 0 });
    // Register an abort handler so abortTurn() succeeds.
    setAbortHandler(() => {});
  });

  afterEach(() => {
    abortStore.clear();
    clearAllHandlers();
  });

  it('single Ctrl+C during a live workflow arms abortStore.pending without exiting', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeCtrlC(ui);
    await tick(20);

    expect(abortStore.get().pending).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('second Ctrl+C within the 2s window calls exit()', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeCtrlC(ui);
    await tick(20);
    expect(exit).not.toHaveBeenCalled();

    writeCtrlC(ui);
    await tick(20);
    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('a Ctrl+C that arrives after the 2s window is treated as a fresh first press', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeCtrlC(ui);
    await tick(20);
    expect(abortStore.get().pending).toBe(true);

    // Wait past the DOUBLE_PRESS_WINDOW_MS (2000ms). The abortStore's internal
    // timer also clears pending at 2s, mirroring the hook's window.
    await tick(2100);

    expect(abortStore.get().pending).toBe(false);

    // A second press after the window re-arms, does NOT exit.
    // Reassert the live phase (lifecycleStore stays set, but guard the fixture).
    expect(lifecycleStore.get().phase).toBe('implementing');
    writeCtrlC(ui);
    await tick(20);

    expect(exit).not.toHaveBeenCalled();
    expect(abortStore.get().pending).toBe(true);
    ui.unmount();
  }, 10000);
});

describe('useAppKeys: keystroke binding', () => {
  beforeEach(() => {
    resetAllStores();
    clearAllHandlers();
    setAbortHandler(() => {});
  });

  afterEach(() => {
    abortStore.clear();
    clearAllHandlers();
  });

  // Case 1: Ctrl+K when no overlay open → opens command-palette
  it('Ctrl+K when no overlay open opens command-palette overlay', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().active).toBe('none');

    ui.stdin.write('\x0b'); // Ctrl+K
    await tick(20);

    expect(overlayStore.get().active).toBe('command-palette');
    ui.unmount();
  });

  // Case 2: Ctrl+K when overlay already open → palette is NOT opened
  it('Ctrl+K when an overlay is already open does not open command-palette', async () => {
    const exit = vi.fn();
    overlayStore.open('settings');
    await tick(20);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    ui.stdin.write('\x0b'); // Ctrl+K
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });

  // Case 3: Ctrl+/ (0x1f) → opens help overlay
  it('Ctrl+/ opens the help overlay', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().active).toBe('none');

    ui.stdin.write('\x1f'); // Ctrl+/
    await tick(20);

    expect(overlayStore.get().active).toBe('help');
    ui.unmount();
  });

  // Case 4: Ctrl+Q → exit() is called
  it('Ctrl+Q calls exit()', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    ui.stdin.write('\x11'); // Ctrl+Q
    await tick(20);

    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  // Case 7: Escape when overlay open and not exclusive → overlayStore.close() called
  it('Escape when overlay is open and not exclusive closes the overlay', async () => {
    const exit = vi.fn();
    overlayStore.open('settings');
    await tick(20);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');

    ui.stdin.write('\x1b'); // Escape
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  // Case 8: Escape when overlay is exclusive → overlayStore.close() NOT called
  it('Escape when overlay is exclusive does not close the overlay', async () => {
    const exit = vi.fn();
    overlayStore.open('settings');
    overlayStore.setExclusive(true);
    await tick(20);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().exclusive).toBe(true);

    ui.stdin.write('\x1b'); // Escape
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });
});

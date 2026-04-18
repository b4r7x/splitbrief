import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { useAppKeys } from './use-app-keys.js';
import { renderFeature, tick } from '../../testing/helpers/ink.js';
import { resetAllStores } from '../../testing/helpers/stores.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore, _lifecycleInternal } from '../stores/workflow/lifecycle.js';
import { abortStore } from '../stores/workflow/abort.js';
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

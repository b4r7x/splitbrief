import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { useAppKeys } from './use-app-keys.js';
import { renderFeature, tick } from '../../testing/helpers/ink.js';
import { resetAllStores } from '../../testing/helpers/stores.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore, _lifecycleInternal } from '../stores/workflow/lifecycle.js';
import { abortStore } from '../stores/workflow/abort.js';
import { overlayStore } from '../stores/ui/overlay.js';

function Harness({ exit, abortWorkflow }: { exit: () => void; abortWorkflow?: () => void }) {
  useAppKeys({ exit, abortWorkflow });
  return (
    <Box>
      <Text>ready</Text>
    </Box>
  );
}

function writeCtrlC(ui: { stdin: { write: (d: string) => void } }) {
  ui.stdin.write('\x03');
}

function writeKey(ui: { stdin: { write: (d: string) => void } }, chars: string) {
  ui.stdin.write(chars);
}

describe('useAppKeys: Ctrl+C double-press abort flow', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1000);
    resetAllStores();
    routerStore.navigate({ to: 'workflow', feature: 'test' });
    _lifecycleInternal.set({ phase: 'implementing', cancelled: false, queueDepth: 0 });
  });

  afterEach(() => {
    abortStore.clear();
    vi.useRealTimers();
  });

  it('single Ctrl+C during a live workflow arms abortStore.pending without exiting', async () => {
    const exit = vi.fn();
    const abortWorkflow = vi.fn();
    const ui = renderFeature(<Harness exit={exit} abortWorkflow={abortWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();

    expect(abortStore.get().pending).toBe(true);
    expect(abortWorkflow).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('second Ctrl+C within the 2s window calls exit()', async () => {
    const exit = vi.fn();
    const abortWorkflow = vi.fn();
    const ui = renderFeature(<Harness exit={exit} abortWorkflow={abortWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    writeCtrlC(ui);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(abortWorkflow).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('a Ctrl+C that arrives after the 2s window is treated as a fresh first press', async () => {
    const exit = vi.fn();
    const abortWorkflow = vi.fn();
    const ui = renderFeature(<Harness exit={exit} abortWorkflow={abortWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();
    expect(abortStore.get().pending).toBe(true);

    vi.advanceTimersByTime(2001);
    await tick();

    expect(abortStore.get().pending).toBe(false);

    expect(lifecycleStore.get().phase).toBe('implementing');
    writeCtrlC(ui);
    await tick();

    expect(exit).not.toHaveBeenCalled();
    expect(abortStore.get().pending).toBe(true);
    expect(abortWorkflow).toHaveBeenCalledTimes(2);
    ui.unmount();
  });
});

describe('useAppKeys: keystroke binding', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    abortStore.clear();
  });

  it.each([
    { name: 'Ctrl+K', input: '\x0b', overlay: 'command-palette' },
    { name: 'Ctrl+/', input: '\x1f', overlay: 'help' },
  ] as const)('$name opens the $overlay overlay', async ({ input, overlay }) => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().active).toBe('none');

    writeKey(ui, input);
    await tick(20);

    expect(overlayStore.get().active).toBe(overlay);
    ui.unmount();
  });

  it('Ctrl+K when an overlay is already open does not open command-palette', async () => {
    const exit = vi.fn();
    overlayStore.open('settings');
    await tick(20);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, '\x0b');
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });

  it('Ctrl+Q calls exit()', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, '\x11');
    await tick(20);

    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('Escape when overlay is open and not exclusive closes the overlay', async () => {
    const exit = vi.fn();
    overlayStore.open('settings');
    await tick(20);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');

    writeKey(ui, '\x1b');
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Escape when overlay is exclusive does not close the overlay', async () => {
    const exit = vi.fn();
    overlayStore.open('settings');
    overlayStore.setExclusive(true);
    await tick(20);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().exclusive).toBe(true);

    writeKey(ui, '\x1b');
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });
});

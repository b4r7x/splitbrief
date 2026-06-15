import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { useAppKeys } from './keys.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore, _lifecycleInternal } from '../stores/workflow/lifecycle.js';
import { abortStore } from '../stores/workflow/abort.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { completionStore } from '../stores/ui/completion.js';
import { controlsStore } from '../stores/ui/controls.js';
import { cancelEscapeAction } from '../lib/terminal/escape-debounce.js';
import * as handlers from '../features/workflow/handlers.js';
import type { InterruptResult } from '../features/workflow/handlers.js';
import { approvalPromptStore, openApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import { costApprovalStore, openCostApprovalPrompt } from '../stores/cost-approval/prompt.js';
import {
  planEditorKeysStore,
  usePlanEditorKeys,
} from '../features/workflow/hooks/use-plan-editor-keys.js';
import type { CostPrediction } from '../core/schemas/summary.js';

// Comfortably past the escape-debounce defer (DEFAULT_DELAY_MS in escape-debounce.ts)
// so the deferred arm flushes without copying that module-private literal here.
const PAST_DEBOUNCE_MS = 100;

function makeCostPrediction(): CostPrediction {
  return {
    estimatedTasks: 1,
    lowCost: 0.01,
    expectedCost: 0.02,
    highCost: 0.05,
    plannerTool: 'anthropic',
    implementerTool: 'anthropic',
    deterministic: {
      taskCount: 1,
      taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
      contextConfidenceCounts: {
        contextExplicit: 1,
        contextDetected: 0,
        contextKnownCatalog: 0,
        contextCachedProvider: 0,
        contextConservativeFallback: 0,
        profileUnavailable: 0,
      },
      priceConfidenceCounts: { priceKnown: 1, priceUnknown: 0, profileUnavailable: 0 },
      tasks: [],
      totals: {
        knownActualEstimate: 0.02,
        hypotheticalAllPlanner: 0.1,
        estimatedSavings: 0.08,
        unknownCostReason: [],
      },
    },
  };
}

function Harness({
  exit,
  interruptWorkflow,
}: {
  exit: () => void;
  interruptWorkflow?: () => InterruptResult;
}) {
  useAppKeys({ exit, interruptWorkflow });
  return (
    <Box>
      <Text>ready</Text>
    </Box>
  );
}

function EditorKeyLayer() {
  usePlanEditorKeys({ onSave: () => Promise.resolve(), sessionDir: '/tmp/session' });
  return null;
}

function EditorHarness({
  exit,
  interruptWorkflow,
  mountEditor = true,
}: {
  exit: () => void;
  interruptWorkflow?: () => InterruptResult;
  mountEditor?: boolean;
}) {
  useAppKeys({ exit, interruptWorkflow });
  return (
    <Box>
      <Text>ready</Text>
      {mountEditor && <EditorKeyLayer />}
    </Box>
  );
}

function writeCtrlC(ui: { stdin: { write: (d: string) => void } }) {
  ui.stdin.write('\x03');
}

function writeEsc(ui: { stdin: { write: (d: string) => void } }) {
  ui.stdin.write('\x1b');
}

function writeKey(ui: { stdin: { write: (d: string) => void } }, chars: string) {
  ui.stdin.write(chars);
}

describe('useAppKeys: Ctrl+C ladder', () => {
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

  it('single Ctrl+C during a live workflow arms exit and interrupts without exiting', async () => {
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'turn');
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();

    expect(abortStore.get().armed).toBe('exit');
    expect(interruptWorkflow).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('interrupting a live workflow closes a pending tiered approval prompt', async () => {
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'turn');
    const pending = openApprovalPrompt({
      tier: 'sticky',
      actionClass: 'network',
      actionDescription: 'push to origin',
      phase: 'implementing',
    });
    expect(approvalPromptStore.get().status).toBe('pending');
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();

    expect(approvalPromptStore.get().status).toBe('idle');
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
    ui.unmount();
  });

  it('interrupting a live workflow closes a pending cost-approval prompt as not approved', async () => {
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'turn');
    const pending = openCostApprovalPrompt(makeCostPrediction());
    expect(costApprovalStore.get().status).toBe('pending');
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();

    expect(costApprovalStore.get().status).toBe('idle');
    await expect(pending).resolves.toBe(false);
    ui.unmount();
  });

  it('second Ctrl+C within the 2s window calls exit()', async () => {
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'turn');
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    writeCtrlC(ui);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(interruptWorkflow).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('a Ctrl+C after the 2s window is a fresh first press, not an exit', async () => {
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'turn');
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();
    expect(abortStore.get().armed).toBe('exit');

    vi.advanceTimersByTime(2001);
    await tick();
    expect(abortStore.get().armed).toBe('none');

    expect(lifecycleStore.get().phase).toBe('implementing');
    writeCtrlC(ui);
    await tick();

    expect(exit).not.toHaveBeenCalled();
    expect(abortStore.get().armed).toBe('exit');
    expect(interruptWorkflow).toHaveBeenCalledTimes(2);
    ui.unmount();
  });

  it('Ctrl+C on the home screen exits immediately on the first press', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'none');
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(interruptWorkflow).not.toHaveBeenCalled();
    expect(abortStore.get().armed).toBe('none');
    ui.unmount();
  });

  it('Ctrl+C in attach mode exits immediately on the first press', async () => {
    routerStore.navigate({ to: 'home' });
    routerStore.navigate({
      to: 'workflow',
      feature: 'test',
      attach: { sockPath: '/tmp/sock', authToken: 'tok' },
    });
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'none');
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(interruptWorkflow).not.toHaveBeenCalled();
    expect(abortStore.get().armed).toBe('none');
    ui.unmount();
  });
});

describe('useAppKeys: ESC interrupt/cancel ladder', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1000);
    resetAllStores();
    routerStore.navigate({ to: 'workflow', feature: 'test' });
    _lifecycleInternal.set({ phase: 'implementing', cancelled: false, queueDepth: 0 });
  });

  afterEach(() => {
    cancelEscapeAction();
    abortStore.clear();
    completionStore.reset();
    handlers.clearAllHandlers();
    _lifecycleInternal.set({ phase: 'idle', cancelled: false, queueDepth: 0 });
    vi.useRealTimers();
  });

  it('ESC during a live phase arms interrupt, then a second ESC interrupts the turn', async () => {
    const abort = vi.fn();
    handlers.setAbortHandler(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={handlers.interruptTurn} />);
    await tick();

    writeEsc(ui);
    await tick();
    // The arm is deferred by the escape-debounce to let a split escape sequence cancel it first.
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(abortStore.get().armed).toBe('interrupt');
    expect(abort).not.toHaveBeenCalled();

    writeEsc(ui);
    await tick();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abortStore.get().armed).toBe('none');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ESC in question mode arms cancel, then a second ESC cancels the workflow', async () => {
    controlsStore.setInputMode('question');
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={() => 'none'} />);
    await tick();

    writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(abortStore.get().armed).toBe('cancel');
    expect(lifecycleStore.get().cancelled).toBe(false);

    writeEsc(ui);
    await tick();
    expect(lifecycleStore.get().cancelled).toBe(true);
    expect(abortStore.get().armed).toBe('none');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('a split escape sequence (ESC then an arrow tail) does not arm', async () => {
    const abort = vi.fn();
    handlers.setAbortHandler(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={handlers.interruptTurn} />);
    await tick();

    // ESC arrives first (deferred), then the rest of an Up-arrow sequence over a slow link.
    writeEsc(ui);
    await tick();
    writeKey(ui, '[A');
    await tick();

    // The non-ESC tail cancels the deferred arm before its debounce deadline.
    vi.advanceTimersByTime(50);
    expect(abortStore.get().armed).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('a split escape sequence in the cancelled state does not navigate home', async () => {
    _lifecycleInternal.set({ phase: 'idle', cancelled: true, queueDepth: 0 });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={() => 'none'} />);
    await tick();

    // ESC arrives first (deferred), then the rest of an Up-arrow sequence over a slow link.
    writeEsc(ui);
    await tick();
    writeKey(ui, '[A');
    await tick();

    // The non-ESC tail cancels the deferred navigate before its deadline.
    vi.advanceTimersByTime(50);
    expect(routerStore.get().screen).toBe('workflow');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('the ESC arming window expires after 2s', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={() => 'none'} />);
    await tick();

    writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(abortStore.get().armed).toBe('interrupt');

    vi.advanceTimersByTime(2001);
    await tick();
    expect(abortStore.get().armed).toBe('none');
    ui.unmount();
  });

  it('ESC never exits the app on the home screen', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={() => 'none'} />);
    await tick();

    writeEsc(ui);
    await tick();
    writeEsc(ui);
    await tick();

    expect(exit).not.toHaveBeenCalled();
    expect(abortStore.get().armed).toBe('none');
    ui.unmount();
  });

  it('ESC does not arm while an overlay is open (only closes the overlay)', async () => {
    overlayStore.open('settings');
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={() => 'none'} />);
    await tick();

    expect(overlayStore.get().active).toBe('settings');

    writeEsc(ui);
    await tick();

    expect(overlayStore.get().active).toBe('none');
    expect(abortStore.get().armed).toBe('none');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ESC does not arm while a tiered approval prompt is pending', async () => {
    const abort = vi.fn();
    handlers.setAbortHandler(abort);
    const exit = vi.fn();
    void openApprovalPrompt({
      tier: 'sticky',
      actionClass: 'network',
      actionDescription: 'push to origin',
      phase: 'implementing',
    });
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={handlers.interruptTurn} />);
    await tick();

    writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    // The ESC arming gate is suppressed while the approval prompt owns the screen, so a press
    // neither arms nor reaches the interrupt/cancel handlers.
    expect(abortStore.get().armed).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ESC does not arm while a cost-approval prompt is pending', async () => {
    const abort = vi.fn();
    handlers.setAbortHandler(abort);
    const exit = vi.fn();
    void openCostApprovalPrompt(makeCostPrediction());
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={handlers.interruptTurn} />);
    await tick();

    writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(abortStore.get().armed).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ESC does not arm while a completion menu is open', async () => {
    const abort = vi.fn();
    handlers.setAbortHandler(abort);
    const exit = vi.fn();
    completionStore.setOpen(true);
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={handlers.interruptTurn} />);
    await tick();

    writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    // The completion menu owns ESC (it dismisses the menu), so the global ladder is suppressed:
    // dismissing the menu neither arms interruption nor reaches the interrupt/cancel handlers.
    expect(abortStore.get().armed).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });
});

describe('useAppKeys: keystroke binding', () => {
  beforeEach(() => {
    resetAllStores();
    planEditorKeysStore.__testReset();
  });

  afterEach(() => {
    abortStore.clear();
    approvalPromptStore.__testReset();
    costApprovalStore.__testReset();
    planEditorKeysStore.__testReset();
  });

  it.each([
    { name: 'Ctrl+K', input: '\x0b', overlay: 'command-palette' },
    { name: 'Ctrl+/ (legacy \\x1f)', input: '\x1f', overlay: 'help' },
    { name: 'Ctrl+/ (kitty CSI-u)', input: '\x1b[47;5u', overlay: 'help' },
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

  it('Ctrl+K does not open command-palette while the rich plan editor key layer is mounted', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<EditorHarness exit={exit} />);
    await tick(20);

    // Mounting the editor's key hook publishes its active state; the global layer releases Ctrl+K.
    expect(planEditorKeysStore.get()).toBe(true);
    expect(overlayStore.get().active).toBe('none');

    writeKey(ui, '\x0b');
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Ctrl+K reopens the command-palette once the rich plan editor key layer unmounts', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<EditorHarness exit={exit} mountEditor={false} />);
    await tick(20);

    expect(planEditorKeysStore.get()).toBe(false);

    writeKey(ui, '\x0b');
    await tick(20);

    expect(overlayStore.get().active).toBe('command-palette');
    ui.unmount();
  });

  it('Ctrl+/ still opens help while the rich plan editor key layer is mounted', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<EditorHarness exit={exit} />);
    await tick(20);

    expect(planEditorKeysStore.get()).toBe(true);

    writeKey(ui, '\x1f');
    await tick(20);

    expect(overlayStore.get().active).toBe('help');
    ui.unmount();
  });

  it('Ctrl+K while a tiered approval prompt is pending does not open an overlay over it', async () => {
    const exit = vi.fn();
    void openApprovalPrompt({
      tier: 'sticky',
      actionClass: 'network',
      actionDescription: 'push to origin',
      phase: 'implementing',
    });
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, '\x0b');
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Ctrl+K while a cost-approval prompt is pending does not open an overlay over it', async () => {
    const exit = vi.fn();
    void openCostApprovalPrompt(makeCostPrediction());
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, '\x0b');
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
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

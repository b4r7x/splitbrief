import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { useAppKeys } from './keys.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { abortStore } from '../stores/workflow/abort.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { completionStore } from '../stores/ui/completion.js';
import { controlsStore } from '../stores/ui/controls.js';
import { cancelEscapeAction } from '../lib/terminal/escape-debounce.js';
import * as handlers from '../features/workflow/handlers.js';
import type { InterruptResult } from '../features/workflow/handlers.js';
import { approvalPromptStore, openApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import { costApprovalStore, openCostApprovalPrompt } from '../stores/cost-approval/prompt.js';
import { editorStore } from '../stores/ui/editor.js';
import { reviewStore } from '../stores/workflow/review.js';

// Comfortably past the escape-debounce defer (DEFAULT_DELAY_MS in escape-debounce.ts)
// so the deferred arm flushes without copying that module-private literal here.
const PAST_DEBOUNCE_MS = 100;

function Harness({
  exit,
  interruptWorkflow,
  cancelWorkflow = handlers.requestCancel,
}: {
  exit: () => void;
  interruptWorkflow?: () => InterruptResult;
  cancelWorkflow?: () => void;
}) {
  useAppKeys({
    exit,
    interruptWorkflow,
    cancelWorkflow,
  });
  return (
    <Box>
      <Text>ready</Text>
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
    lifecycleStore.__testReset({ phase: 'implementing' });
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

  it('Ctrl+C while the workflow is interrupted arms exit without re-interrupting', async () => {
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'turn');
    lifecycleStore.__testReset({ phase: 'implementing', status: 'interrupted' });
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();

    expect(abortStore.get().armed).toBe('exit');
    expect(interruptWorkflow).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('Ctrl+C in question mode arms exit without interrupting the turn', async () => {
    const exit = vi.fn();
    const interruptWorkflow = vi.fn<() => InterruptResult>(() => 'turn');
    controlsStore.setInputMode('question');
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={interruptWorkflow} />);
    await tick();

    writeCtrlC(ui);
    await tick();

    expect(abortStore.get().armed).toBe('exit');
    expect(interruptWorkflow).not.toHaveBeenCalled();
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
    lifecycleStore.__testReset({ phase: 'implementing' });
  });

  afterEach(() => {
    cancelEscapeAction();
    abortStore.clear();
    completionStore.reset();
    handlers.clearAllHandlers();
    lifecycleStore.__testReset();
    vi.useRealTimers();
  });

  it('ESC during a live phase arms interrupt, then a second ESC interrupts the turn', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
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

  it('second ESC in question mode invokes the workflow cancel port', async () => {
    controlsStore.setInputMode('question');
    const cancelWorkflow = vi.fn();
    const ui = renderFeature(
      <Harness exit={vi.fn()} interruptWorkflow={() => 'none'} cancelWorkflow={cancelWorkflow} />,
    );
    await tick();

    writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    writeEsc(ui);
    await tick();

    expect(cancelWorkflow).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('double Esc while interrupted arms and fires workflow cancel', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'interrupted' });
    const exit = vi.fn();
    const cancelWorkflow = vi.fn();
    const ui = renderFeature(
      <Harness exit={exit} interruptWorkflow={() => 'none'} cancelWorkflow={cancelWorkflow} />,
    );
    await tick();

    writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(abortStore.get().armed).toBe('cancel');

    writeEsc(ui);
    await tick();

    expect(cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('a split escape sequence (ESC then an arrow tail) does not arm', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
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
    lifecycleStore.__testReset({ cancelled: true });
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

  it('ESC on the summary screen navigates home without exiting', async () => {
    routerStore.navigate({
      to: 'summary',
      summary: makeSummary(),
      status: 'complete',
      sessionId: 'summary-session',
    });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={() => 'none'} />);
    await tick();

    writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(routerStore.get().screen).toBe('home');
    expect(exit).not.toHaveBeenCalled();
    expect(abortStore.get().armed).toBe('none');
    ui.unmount();
  });

  it('a split escape sequence on the summary screen does not navigate home', async () => {
    routerStore.navigate({
      to: 'summary',
      summary: makeSummary(),
      status: 'complete',
      sessionId: 'summary-session',
    });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} interruptWorkflow={() => 'none'} />);
    await tick();

    writeEsc(ui);
    await tick();
    writeKey(ui, '[A');
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(routerStore.get().screen).toBe('summary');
    expect(exit).not.toHaveBeenCalled();
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
    handlers.createAbortHandlerScope()(abort);
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
    handlers.createAbortHandlerScope()(abort);
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
    handlers.createAbortHandlerScope()(abort);
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
  });

  afterEach(() => {
    abortStore.clear();
    approvalPromptStore.__testReset();
    costApprovalStore.__testReset();
  });

  it.each([
    { name: 'Ctrl+K', input: '\x0b', overlay: 'command-palette' },
    { name: 'Ctrl+,', input: '\x1b[44;5u', overlay: 'settings' },
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

  it('Ctrl+, does not open local settings in an attached client', async () => {
    routerStore.navigate({
      to: 'workflow',
      feature: 'attached feature',
      attach: { sockPath: '/tmp/diptych.sock', authToken: 'tok' },
    });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, '\x1b[44;5u');
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
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

  it('Escape closes a stacked passive overlay back to its parent (help over settings -> settings)', async () => {
    const exit = vi.fn();
    // The command palette closes itself before launching the chosen overlay, so opening Help from
    // the palette over Settings leaves Settings beneath Help on the stack.
    overlayStore.open('settings');
    overlayStore.open('command-palette');
    overlayStore.close();
    overlayStore.open('help');
    await tick(20);
    expect(overlayStore.get().active).toBe('help');
    expect(overlayStore.get().stack.length).toBe(1);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, '\x1b');
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });

  it('Escape leaves a stacked self-closing overlay to its own handler (no global double-pop)', async () => {
    const exit = vi.fn();
    // A runner picker carries its own Escape handler. The global close must stand down while it sits
    // on a non-empty stack, or one Escape would fire both handlers and skip past Settings.
    overlayStore.open('settings');
    overlayStore.open('planner-picker');
    await tick(20);
    expect(overlayStore.get().active).toBe('planner-picker');
    expect(overlayStore.get().stack.length).toBe(1);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, '\x1b');
    await tick(20);

    expect(overlayStore.get().active).toBe('planner-picker');
    ui.unmount();
  });
});

describe('useAppKeys: suppressed while the inline briefs field editor owns input', () => {
  const LAYOUT = { columns: 40, rows: 6 };

  beforeEach(() => {
    resetAllStores();
    routerStore.navigate({ to: 'workflow', feature: 'field-edit test' });
    // The field editor is not an overlay: give a field session ownership of the live prompt by
    // matching its captured token to reviewStore.ownerToken (the CON-B ownership predicate).
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({
      filePath: '/tmp/TASKS.md',
      value: 'x',
      ownerToken: token,
      layout: LAYOUT,
    });
  });

  afterEach(() => {
    editorStore.close();
    reviewStore.clearReview();
    abortStore.clear();
  });

  it.each([
    { name: 'Ctrl+K', input: '\x0b' },
    { name: 'Ctrl+,', input: '\x1b[44;5u' },
    { name: 'Ctrl+/ (legacy \\x1f)', input: '\x1f' },
  ] as const)('$name does not open an overlay over the field editor', async ({ input }) => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, input);
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Ctrl+Q does not exit while the field editor owns input', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    writeKey(ui, '\x11');
    await tick(20);

    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });
});

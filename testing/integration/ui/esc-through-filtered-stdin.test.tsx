import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { ThemeProvider } from '../../../src/components/theme.js';
import { useAppKeys } from '../../../src/app/keys.js';
import { useWorkflowKeys } from '../../../src/features/workflow/hooks/use-keys.js';
import { FeedbackRow } from '../../../src/features/workflow/components/feedback-row.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { abortStore } from '../../../src/stores/workflow/abort.js';
import { controlsStore } from '../../../src/stores/ui/controls.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { cancelEscapeAction } from '../../../src/lib/terminal/escape-debounce.js';
import * as handlers from '../../../src/features/workflow/handlers.js';
import type { InterruptResult } from '../../../src/features/workflow/handlers.js';

// End-to-end regression guards. ESC and Ctrl+C bytes travel through the production
// FilteredStdin (mouse filter + bracketed-paste stripper) before reaching Ink — the path
// src/cli/render/app.ts wires and the path src/app/keys.test.tsx bypasses. They pin the
// user-visible ladder (arm on the FIRST press; interrupt on the SECOND) so a future filter
// change cannot silently swallow a leading control byte. The armed kind drives the
// FeedbackRow hint copy, which is asserted once for its render integration below.

const ESC = '\x1b';
const CTRL_C = '\x03';
// Generous real-timer waits: the filter delivers via stream `data` events and the
// arming action is deferred ~35ms by the escape-debounce, so allow margin for both.
// Wide margin so the deferred escape + navigation completes even under full-suite event-loop load.
const AFTER_PRESS_MS = 200;

function InstantWorkflowApp({
  exit = () => {},
  interruptWorkflow = handlers.interruptTurn,
}: {
  exit?: () => void;
  interruptWorkflow?: () => InterruptResult;
}) {
  // Mirror the real workflow screen: both global app keys and the workflow-screen keys
  // are mounted, because the ESC->home-when-cancelled hop lives in useWorkflowKeys.
  useAppKeys({
    exit,
    interruptWorkflow,
    cancelWorkflow: handlers.requestCancel,
  });
  useWorkflowKeys({ isActive: true });
  return (
    <ThemeProvider>
      <Box flexDirection="column">
        <FeedbackRow />
        <Text>workflow running</Text>
      </Box>
    </ThemeProvider>
  );
}

describe('ESC through the real FilteredStdin pipeline (instant-mode workflow)', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    handlers.clearAllHandlers();
    cancelEscapeAction();
    projectDir = createTempDir('filtered-stdin-workflow');
    const prepared = prepareWorkflowExecution({
      projectDir,
      feature: 'instant feature',
      config: makeConfig(),
      sessionId: 'filtered-stdin-session',
    });
    routerStore.navigate({
      to: 'workflow',
      execution: { kind: 'local', prepared },
    });
    // Instant mode runs planning under the 'researching' live phase (init.ts dispatches
    // START before runInstantPlanning, and 'researching' is a live phase).
    lifecycleStore.__testReset({ phase: 'researching' });
  });

  afterEach(() => {
    cancelEscapeAction();
    abortStore.clear();
    handlers.clearAllHandlers();
    lifecycleStore.__testReset();
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('arms interrupt and renders a feedback hint on the FIRST lone ESC during a live phase', async () => {
    const harness = renderThroughFilteredStdin(<InstantWorkflowApp />);
    await tick(30);
    const idleFrame = harness.lastFrame() ?? '';

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);

    // The first ESC reaches Ink through the filter and arms 'interrupt'; the FeedbackRow
    // reacts by rendering the armed-state hint, so the frame changes from its idle state.
    expect(abortStore.get().armed).toBe('interrupt');
    expect(harness.lastFrame() ?? '').not.toBe(idleFrame);

    harness.unmount();
  });

  it('a batched double ESC (\\x1b\\x1b in one chunk) interrupts immediately', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const harness = renderThroughFilteredStdin(<InstantWorkflowApp />);
    await tick(30);

    // Terminals can batch two fast ESC keystrokes into a single chunk; the filter passes
    // both through (splitMouseChunk + stripPasteMarkers do not withhold the trailing ESC).
    harness.pressBytes(ESC + ESC);
    await tick(AFTER_PRESS_MS);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abortStore.get().armed).toBe('none');

    harness.unmount();
  });

  it('runs the full ESC ladder to completion: interrupt -> cancel -> home', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<InstantWorkflowApp exit={exit} />);
    await tick(30);

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(abortStore.get().armed).toBe('interrupt');

    // Press 2: interrupt the current step. The orchestrator would flip the UI into the
    // continuation/question prompt; emulate that store transition the engine performs.
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(abort).toHaveBeenCalledTimes(1);
    controlsStore.setInputMode('question');
    await tick(10);

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(abortStore.get().armed).toBe('cancel');

    // Press 4: cancel the whole workflow. One physical keypress is at most one semantic
    // action, so the press that cancels must stay on the workflow screen — navigation home
    // is a separate decision that belongs to the next fresh press, not this one.
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(lifecycleStore.get().cancelled).toBe(true);
    expect(routerStore.get().screen).toBe('workflow');

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(routerStore.get().screen).toBe('home');

    expect(exit).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('stops on the second ESC (instant-planning fallback, no abort handler) and stays on the workflow screen', async () => {
    // Instant planning registers no abort handler, so interruptTurn falls back to
    // requestCancel(), which synchronously marks the lifecycle cancelled. With both the app
    // keys and the workflow-screen keys mounted (the real workflow view), that single press
    // must do exactly one thing: stop the run. Navigating home is a separate, later decision.
    const harness = renderThroughFilteredStdin(<InstantWorkflowApp />);
    await tick(30);

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(abortStore.get().armed).toBe('interrupt');
    expect(routerStore.get().screen).toBe('workflow');

    // Press 2: with no abort handler the fallback cancels the workflow. The very press that
    // stops the run must leave the user on the workflow screen, looking at the stopped state.
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(lifecycleStore.get().cancelled).toBe(true);
    expect(routerStore.get().screen).toBe('workflow');
    expect(harness.lastFrame() ?? '').toContain('workflow running');

    // A fresh, separate ESC after the stop is what navigates back home.
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(routerStore.get().screen).toBe('home');

    harness.unmount();
  });

  it('arms identically for a kitty-encoded ESC (\\x1b[27u) and a bare ESC (\\x1b)', async () => {
    // Under kitty disambiguateEscapeCodes the Escape key can arrive either as CSI-u
    // \x1b[27u (which Ink decodes to key.escape, passed through the filter intact) or as a
    // bare \x1b. Both encodings must arm the interrupt hint on the first press, so neither
    // path can be swallowed by FilteredStdin.
    const kitty = renderThroughFilteredStdin(<InstantWorkflowApp />);
    await tick(30);
    kitty.pressBytes('\x1b[27u');
    await tick(AFTER_PRESS_MS);
    const kittyArmed = abortStore.get().armed;
    kitty.unmount();
    abortStore.clear();
    await tick(10);

    const bare = renderThroughFilteredStdin(<InstantWorkflowApp />);
    await tick(30);
    bare.pressBytes('\x1b');
    await tick(AFTER_PRESS_MS);
    const bareArmed = abortStore.get().armed;
    bare.unmount();

    // Both encodings arm the interrupt on a single press.
    expect(kittyArmed).toBe('interrupt');
    expect(bareArmed).toBe('interrupt');
  });

  it('runs the Ctrl+C ladder through the real FilteredStdin: first interrupts and arms exit, second exits', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<InstantWorkflowApp exit={exit} />);
    await tick(30);

    // Press 1: Ctrl+C reaches Ink through the filter, interrupts the live turn, and arms
    // the exit hint. (Ctrl+C is read synchronously, with no escape-debounce defer.)
    harness.pressBytes(CTRL_C);
    await tick(AFTER_PRESS_MS);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abortStore.get().armed).toBe('exit');
    expect(exit).not.toHaveBeenCalled();

    // Press 2 within the window: exits.
    harness.pressBytes(CTRL_C);
    await tick(AFTER_PRESS_MS);
    expect(exit).toHaveBeenCalledTimes(1);

    harness.unmount();
  });

  it('does not arm for a lone ESC inside a bracketed paste; the pasted text reaches the app', async () => {
    const harness = renderThroughFilteredStdin(<InstantWorkflowApp />);
    const delivered: string[] = [];
    harness.filtered.stdin.on('data', (chunk: Buffer) => delivered.push(chunk.toString('utf8')));
    await tick(30);

    // Open the paste, type, then a raw ESC arrives mid-paste, then more text closes it.
    harness.pressBytes('\x1b[200~abc');
    await tick(20);
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    harness.pressBytes('def\x1b[201~');
    await tick(AFTER_PRESS_MS);

    // The ESC is part of pasted content (isPasteActive guards keys.ts), so nothing arms.
    expect(abortStore.get().armed).toBe('none');
    // The printable paste body reaches Ink with the \x1b[200~ / \x1b[201~ markers stripped.
    const seen = delivered.join('');
    expect(seen).toContain('abc');
    expect(seen).toContain('def');
    expect(seen).not.toContain('[200~');
    expect(seen).not.toContain('[201~');

    harness.unmount();
  });

  it('does not deliver a bare carriage return to the app for a CR inside a bracketed paste', async () => {
    const harness = renderThroughFilteredStdin(<InstantWorkflowApp />);
    const delivered: string[] = [];
    harness.filtered.stdin.on('data', (chunk: Buffer) => delivered.push(chunk.toString('utf8')));
    await tick(30);

    // A multi-line paste whose body contains a raw CR. Were the CR forwarded, Ink would parse it
    // as a Return keypress and fire the composer's submit mid-paste; the filter must rewrite it to
    // a newline so the app only ever sees a line break, never a bare carriage return.
    harness.pressBytes('\x1b[200~first\rsecond\x1b[201~');
    await tick(AFTER_PRESS_MS);

    const seen = delivered.join('');
    expect(seen).not.toContain('\r');
    expect(seen).toContain('first\nsecond');
    expect(seen).not.toContain('[200~');
    expect(seen).not.toContain('[201~');

    harness.unmount();
  });

  it('closes an open overlay on ESC and does not arm the interrupt', async () => {
    overlayStore.open('settings');
    const harness = renderThroughFilteredStdin(<InstantWorkflowApp />);
    await tick(30);
    expect(overlayStore.get().active).toBe('settings');

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);

    // ESC closes the overlay; the arming path is gated off while an overlay is open.
    expect(overlayStore.get().active).toBe('none');
    expect(abortStore.get().armed).toBe('none');

    harness.unmount();
  });
});

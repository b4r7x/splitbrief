import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
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
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { composerLiveStore } from '../../../src/stores/ui/composer-live.js';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { cancelEscapeAction } from '../../../src/lib/terminal/escape-debounce.js';
import * as handlers from '../../../src/features/workflow/handlers.js';

// End-to-end regression guards. ESC and Ctrl+C bytes travel through the production
// FilteredStdin (mouse filter + bracketed-paste stripper) before reaching Ink — the path
// src/cli/render/app.ts wires and the path src/app/keys.test.tsx bypasses. They pin the
// user-visible ladder (one esc opens the stop sheet; ctrl+c stops now) so a future filter
// change cannot silently swallow a leading control byte. Drafts survive opening the menu.

const ESC = '\x1b';
const CTRL_C = '\x03';
// Generous real-timer waits: the filter delivers via stream `data` events and the
// arming action is deferred ~35ms by the escape-debounce, so allow margin for both.
// Wide margin so the deferred escape + navigation completes even under full-suite event-loop load.
const AFTER_PRESS_MS = 200;

function WorkflowApp({ exit = () => {} }: { exit?: () => void }) {
  // Mount both keyboard owners, as the real workflow does, to catch a press reaching both.
  useAppKeys({ exit });
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

describe('ESC through the real FilteredStdin pipeline (live workflow)', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    handlers.clearAllHandlers();
    cancelEscapeAction();
    projectDir = createTempDir('filtered-stdin-workflow');
    const prepared = prepareWorkflowExecution({
      projectDir,
      feature: 'esc ladder feature',
      config: makeConfig(),
      sessionId: 'filtered-stdin-session',
    });
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord(),
      execution: { kind: 'local', prepared },
    });
    // 'researching' is a live phase, which is what gates the ESC arming ladder.
    lifecycleStore.__testReset({ phase: 'researching' });
  });

  afterEach(() => {
    cancelEscapeAction();
    stopStore.__testReset();
    handlers.clearAllHandlers();
    lifecycleStore.__testReset();
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('opens the stop sheet on the FIRST lone ESC during a live phase', async () => {
    const harness = renderThroughFilteredStdin(<WorkflowApp />);
    await tick(30);

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);

    expect(overlayStore.get().active).toBe('stop-sheet');
    expect(stopStore.get().intent).toBe('none');

    harness.unmount();
  });

  it('opens the menu while preserving a draft', async () => {
    composerLiveStore.setDraft(createDraftDocument('draft'));
    const harness = renderThroughFilteredStdin(<WorkflowApp />);
    await tick(30);
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(overlayStore.get().active).toBe('stop-sheet');
    expect(composerLiveStore.get().empty).toBe(false);
    expect(stopStore.get().intent).toBe('none');
    harness.unmount();
  });

  it('a batched double ESC (\\x1b\\x1b in one chunk) stops once without ending the run', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const harness = renderThroughFilteredStdin(<WorkflowApp />);
    await tick(30);

    harness.pressBytes(ESC + ESC);
    await tick(AFTER_PRESS_MS);

    expect(overlayStore.get().active).toBe('none');
    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('stop-now');

    harness.unmount();
  });

  it('three separately delivered Escapes stop once, then leave after persistence finishes', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(overlayStore.get().active).toBe('stop-sheet');
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.get().cancelled).toBe(false);
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(routerStore.get().screen).toBe('workflow');
    stopStore.markSettling();
    expect(routerStore.get().screen).toBe('workflow');
    stopStore.park('mid-brief', null, null);
    await tick(30);
    expect(routerStore.get().screen).toBe('home');
    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('stop-now');
    expect(exit).not.toHaveBeenCalled();
    harness.unmount();
  });

  it.each([
    { name: 'bare', sequence: ESC.repeat(3) },
    { name: 'Kitty CSI-u', sequence: '\x1b[27u'.repeat(3) },
  ])(
    'coalesced $name triple Escape queues leave without waiting for the stop to finish',
    async ({ sequence }) => {
      const abort = vi.fn();
      handlers.createAbortHandlerScope()(abort);
      const exit = vi.fn();
      const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
      await tick(30);
      harness.pressBytes(sequence);
      await tick(AFTER_PRESS_MS);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(routerStore.get().screen).toBe('workflow');
      expect(lifecycleStore.get().cancelled).toBe(false);
      stopStore.park('mid-brief', null, null);
      await tick(30);
      expect(routerStore.get().screen).toBe('home');
      expect(abort).toHaveBeenCalledTimes(1);
      expect(stopStore.get().intent).toBe('stop-now');
      expect(exit).not.toHaveBeenCalled();
      harness.unmount();
    },
  );

  it('Ctrl+C after a pending leave upgrades the single terminal action to quit', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);
    harness.pressBytes(ESC + ESC + ESC);
    await tick(AFTER_PRESS_MS);
    harness.pressBytes(CTRL_C);
    await tick(30);
    expect(exit).not.toHaveBeenCalled();
    expect(routerStore.get().screen).toBe('workflow');
    stopStore.park('mid-brief', null, null);
    await tick(30);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(routerStore.get().screen).toBe('workflow');
    expect(abort).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('opens the sheet identically for a kitty-encoded ESC (\\x1b[27u) and a bare ESC (\\x1b)', async () => {
    // Under kitty disambiguateEscapeCodes the Escape key can arrive either as CSI-u
    // \x1b[27u (which Ink decodes to key.escape, passed through the filter intact) or as a
    // bare \x1b. Both encodings must reach the sheet on the first press, so neither
    // path can be swallowed by FilteredStdin.
    const kitty = renderThroughFilteredStdin(<WorkflowApp />);
    await tick(30);
    kitty.pressBytes('\x1b[27u');
    await tick(AFTER_PRESS_MS);
    const kittyOverlay = overlayStore.get().active;
    kitty.unmount();
    overlayStore.reset();
    await tick(10);

    const bare = renderThroughFilteredStdin(<WorkflowApp />);
    await tick(30);
    bare.pressBytes('\x1b');
    await tick(AFTER_PRESS_MS);
    const bareOverlay = overlayStore.get().active;
    bare.unmount();

    expect(kittyOverlay).toBe('stop-sheet');
    expect(bareOverlay).toBe('stop-sheet');
  });

  it('stops now on Ctrl+C through the real FilteredStdin without exiting', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);

    // Ctrl+C is read synchronously, with no escape-debounce defer and no armed window.
    harness.pressBytes(CTRL_C);
    await tick(AFTER_PRESS_MS);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopStore.get()).toMatchObject({ intent: 'stop-now', phase: 'requested' });
    expect(exit).not.toHaveBeenCalled();

    harness.unmount();
  });

  it('a repeated Ctrl+C quits only after the original stop settles', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);
    harness.pressBytes(CTRL_C);
    await tick(30);
    expect(feedbackStore.get().message).toBe('Press ctrl+c again to quit');
    harness.pressBytes(CTRL_C);
    await tick(30);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    stopStore.markSettling();
    expect(exit).not.toHaveBeenCalled();
    stopStore.park('mid-brief', null, null);
    await tick(30);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.get().cancelled).toBe(false);
    harness.unmount();
  });

  it('home Ctrl+C displays a confirmation and quits on the second press', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);
    harness.pressBytes(CTRL_C);
    await tick(30);
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).toBe('Press ctrl+c again to quit');
    harness.pressBytes(CTRL_C);
    await tick(30);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('none');
    harness.unmount();
  });

  it('a batched double Ctrl+C (\\x03\\x03 in one chunk) quits a run parked behind its session options', async () => {
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('expected workflow');
    stopStore.request('stop-now');
    stopStore.park('mid-brief', null, null);
    routerStore.updateRun({ run: route.run, execution: { kind: 'at-rest' } });
    overlayStore.open('stop-sheet');
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);
    harness.pressBytes(CTRL_C + CTRL_C);
    await tick(30);
    expect(exit).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('typed text and a batched double Ctrl+C (fix\\x03\\x03 in one chunk) quit a parked run', async () => {
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('expected workflow');
    stopStore.request('stop-now');
    stopStore.park('mid-brief', null, null);
    routerStore.updateRun({ run: route.run, execution: { kind: 'at-rest' } });
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);
    harness.pressBytes(`fix${CTRL_C}${CTRL_C}`);
    await tick(30);
    expect(exit).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('stops now on a Ctrl+C read with typed text (\\x03fix in one chunk) without exiting', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);
    harness.pressBytes(`${CTRL_C}fix`);
    await tick(AFTER_PRESS_MS);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopStore.get()).toMatchObject({ intent: 'stop-now', phase: 'requested' });
    expect(exit).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('does not arm for a lone ESC inside a bracketed paste; the pasted text reaches the app', async () => {
    const harness = renderThroughFilteredStdin(<WorkflowApp />);
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

    // The ESC is part of pasted content (isPasteActive guards keys.ts), so no sheet opens.
    expect(overlayStore.get().active).toBe('none');
    // The printable paste body reaches Ink with the \x1b[200~ / \x1b[201~ markers stripped.
    const seen = delivered.join('');
    expect(seen).toContain('abc');
    expect(seen).toContain('def');
    expect(seen).not.toContain('[200~');
    expect(seen).not.toContain('[201~');

    harness.unmount();
  });

  it('does not deliver a bare carriage return to the app for a CR inside a bracketed paste', async () => {
    const harness = renderThroughFilteredStdin(<WorkflowApp />);
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

  it('closes an open overlay on ESC instead of opening the stop sheet', async () => {
    overlayStore.open('settings');
    const harness = renderThroughFilteredStdin(<WorkflowApp />);
    await tick(30);
    expect(overlayStore.get().active).toBe('settings');

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);

    // ESC closes the overlay; the stop path is gated off while an overlay is open.
    expect(overlayStore.get().active).toBe('none');
    expect(stopStore.get().intent).toBe('none');

    harness.unmount();
  });
});

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
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { composerLiveStore } from '../../../src/stores/ui/composer-live.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { cancelEscapeAction } from '../../../src/lib/terminal/escape-debounce.js';
import * as handlers from '../../../src/features/workflow/handlers.js';

// End-to-end regression guards. ESC and Ctrl+C bytes travel through the production
// FilteredStdin (mouse filter + bracketed-paste stripper) before reaching Ink — the path
// src/cli/render/app.ts wires and the path src/app/keys.test.tsx bypasses. They pin the
// user-visible ladder (one esc opens the stop sheet; ctrl+c stops now) so a future filter
// change cannot silently swallow a leading control byte. The draft guard drives the
// FeedbackRow hint copy, which is asserted once for its render integration below.

const ESC = '\x1b';
const CTRL_C = '\x03';
// Generous real-timer waits: the filter delivers via stream `data` events and the
// arming action is deferred ~35ms by the escape-debounce, so allow margin for both.
// Wide margin so the deferred escape + navigation completes even under full-suite event-loop load.
const AFTER_PRESS_MS = 200;

function WorkflowApp({ exit = () => {} }: { exit?: () => void }) {
  // Mirror the real workflow screen: both global app keys and the workflow-screen keys
  // are mounted, because the ESC->home-when-cancelled hop lives in useWorkflowKeys.
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

  it('renders the draft guard hint instead of opening the sheet while text is typed', async () => {
    composerLiveStore.setEmpty(false);
    const harness = renderThroughFilteredStdin(<WorkflowApp />);
    await tick(30);
    const idleFrame = harness.lastFrame() ?? '';

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);

    expect(overlayStore.get().active).toBe('none');
    expect(harness.lastFrame() ?? '').not.toBe(idleFrame);
    expect(harness.lastFrame() ?? '').toContain('clear the draft');

    harness.unmount();
  });

  it('a batched double ESC (\\x1b\\x1b in one chunk) opens the sheet and dismisses it', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const harness = renderThroughFilteredStdin(<WorkflowApp />);
    await tick(30);

    // Terminals can batch two fast ESC keystrokes into a single chunk; the filter passes both
    // through (splitMouseChunk + stripPasteMarkers do not withhold the trailing ESC). Each press
    // is one action now — the first opens the sheet and the second dismisses it, and neither
    // touches the run.
    harness.pressBytes(ESC + ESC);
    await tick(AFTER_PRESS_MS);

    expect(overlayStore.get().active).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('none');

    harness.unmount();
  });

  it('runs the stop ladder to completion: sheet -> end run -> home', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const harness = renderThroughFilteredStdin(<WorkflowApp exit={exit} />);
    await tick(30);

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(overlayStore.get().active).toBe('stop-sheet');

    // The sheet's own esc closes it with no effect on the run.
    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(overlayStore.get().active).toBe('none');
    expect(lifecycleStore.get().cancelled).toBe(false);

    // Ending the run is what stops it; the press that stops must stay on the workflow screen.
    handlers.setCancelHandler(() => handlers.requestCancel);
    handlers.requestEndRun();
    await tick(10);
    expect(lifecycleStore.get().cancelled).toBe(true);
    expect(routerStore.get().screen).toBe('workflow');

    harness.pressBytes(ESC);
    await tick(AFTER_PRESS_MS);
    expect(routerStore.get().screen).toBe('home');

    expect(exit).not.toHaveBeenCalled();
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

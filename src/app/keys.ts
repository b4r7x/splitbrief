import { useEffect, useRef } from 'react';
import { stopStore } from '../stores/workflow/stop.js';
import { useInput, type Key } from 'ink';
import { feedbackStore } from '../stores/ui/feedback.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { approvalPromptStore } from '../stores/approval-prompt/prompt.js';
import { completionStore } from '../stores/ui/completion.js';
import { getActiveFilteredStdin } from '../lib/terminal/filtered-stdin/active.js';
import {
  scheduleEscapeAction,
  cancelEscapeAction,
  isEscapeActionPending,
} from '../lib/terminal/escape-debounce.js';
import { useFieldSessionOwned } from '../features/editor/use-field-session-owned.js';
import { useStores } from '../stores/use-stores.js';
import { assertNever } from '../utils/type-guards.js';
import { SEAT_PICKER_OVERLAYS, type OverlayType } from '../core/navigation/types.js';
import { requestQuit, requestStopNow, requestLeaveSession } from '../features/workflow/handlers.js';
import { sessionSelectStore } from '../stores/navigation/session-select.js';
import type { CopyOutcome } from '../lib/clipboard/clipboard.js';
import { formatCopyResult } from '../core/runtime/commands/types.js';
import { refreshSkills } from './refresh-skills.js';

type AppKeyAction =
  | { type: 'none' }
  | { type: 'exit' }
  | { type: 'quit' }
  | { type: 'open-overlay'; overlay: OverlayType };

const NONE: AppKeyAction = { type: 'none' };

// Help renders no Escape handler of its own and relies on this global close. Every other overlay
// closes itself on Escape, so the global handler must stand down once one of them sits on a
// non-empty stack — otherwise a single Escape would fire both handlers and pop past the parent
// (e.g. a runner picker opened from settings would skip settings and close outright).
const GLOBAL_ESC_OVERLAYS = new Set<OverlayType>(['help']);

// These overlays handle Escape themselves — the runner pickers give it a meaning beyond closing
// (a non-empty filter query clears first, only a second press exits). The global close must stand
// down for them even on an empty stack, or one press would fire both handlers.
const SELF_ESC_OVERLAYS = new Set<OverlayType>(SEAT_PICKER_OVERLAYS);

/** The three effects an app-level key spends: two run controls and the skill rescan. */
export interface AppKeyDeps {
  requestQuit: typeof requestQuit;
  requestStopNow: typeof requestStopNow;
  refreshSkills: typeof refreshSkills;
}

const defaultAppKeyDeps: AppKeyDeps = {
  requestQuit,
  requestStopNow,
  refreshSkills,
};

interface UseAppKeysOptions {
  exit: () => void;
  deps?: AppKeyDeps | undefined;
}

function applyAction(action: AppKeyAction, exit: () => void, deps: AppKeyDeps) {
  switch (action.type) {
    case 'none':
      return;
    case 'exit':
      exit();
      return;
    case 'quit':
      deps.requestQuit(exit);
      return;
    case 'open-overlay':
      // Discovery otherwise runs only at startup, so a skill directory added mid-session would
      // stay invisible until a restart. Rescanning here rather than on the picker's mount keeps
      // the scan off the render path the visual fixtures drive.
      if (action.overlay === 'skills') void deps.refreshSkills();
      overlayStore.open(action.overlay);
      return;
    default:
      return assertNever(action);
  }
}

// A run that can still be stopped answers esc with the sheet. A question prompt, a review gate and
// a validation stage are all part of that run, so none of them takes the press for itself.
function stopSheetReachable(): boolean {
  const { cancelled, status } = lifecycleStore.get();
  if (cancelled) return false;
  return status === 'running' || status === 'interrupted';
}

function openStopSheet(): void {
  overlayStore.open('stop-sheet');
}

function goHome(): void {
  requestLeaveSession();
}

function stoppedOrStopping(): boolean {
  const { phase, intent } = stopStore.get();
  return (
    phase === 'parked' || phase === 'ended' || (intent !== 'none' && intent !== 'pause-after-brief')
  );
}

function isSecondEscapePress(input: string): boolean {
  return (
    (input.length > 0 && input.split('').every((char) => char === '\x1b')) ||
    isEscapeActionPending()
  );
}

// A late read hands Ink every byte it collected as one input, so two Ctrl+C presses arrive as
// `\x03\x03` with no ctrl flag, and text typed around them shares the chunk (`fix\x03\x03`). Each
// `\x03` is still one press, and every other byte is other input, in the order it was typed.
function ctrlCKeys(input: string, key: Key): ('press' | 'other')[] {
  if (key.ctrl && input === 'c') return ['press'];
  return Array.from(input, (char) => (char === '\x03' ? 'press' : 'other'));
}

function runDeferredEscape(input: string, immediate: () => void, deferred: () => void): void {
  if (isSecondEscapePress(input)) {
    cancelEscapeAction();
    immediate();
    return;
  }
  scheduleEscapeAction(deferred);
}

export function useAppKeys({ exit, deps = defaultAppKeyDeps }: UseAppKeysOptions) {
  const quitUntil = useRef(0);
  const copyRevision = useRef(0);
  const quitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exited = useRef(false);
  const exitOnce = () => {
    if (!exited.current) {
      exited.current = true;
      exit();
    }
  };
  const clearQuitHint = () => {
    copyRevision.current++;
    quitUntil.current = 0;
    clearTimeout(quitTimer.current);
    if (feedbackStore.get().message === 'Press ctrl+c again to quit')
      feedbackStore.setMessage(null);
  };
  const armQuit = () => {
    clearTimeout(quitTimer.current);
    quitUntil.current = Date.now() + 2000;
    feedbackStore.setMessage('Press ctrl+c again to quit');
    quitTimer.current = setTimeout(clearQuitHint, 2000);
  };
  const [route, overlay, approval, completion, sessionSelection] = useStores(
    routerStore,
    overlayStore,
    approvalPromptStore,
    completionStore,
    sessionSelectStore,
  );
  const { active: overlayActive, exclusive: overlayExclusive } = overlay;
  const isOpen = overlayActive !== 'none';
  const overlayHasStack = overlay.stack.length > 0;
  const overlayClosesOnGlobalEscape =
    !SELF_ESC_OVERLAYS.has(overlayActive) &&
    (!overlayHasStack || GLOBAL_ESC_OVERLAYS.has(overlayActive));
  const promptPending = approval.status === 'pending';
  const completionOpen = completion.open;
  const sessionPreparationActive = sessionSelection.preparation.kind !== 'idle';
  // The inline briefs field editor is not an overlay (it renders inside the workflow screen), so
  // overlayStore.active stays 'none' while it owns input. Every app-level handler that could steal
  // a keystroke from it — the global shortcut chords and the workflow Escape ladder — must stand
  // down while the field session owns the live prompt, mirroring the workflow screen's
  // globalKeysActive gate so exactly one useInput owns each key/mouse event (REQ-049 / CON-D).
  const fieldSessionOwned = useFieldSessionOwned();

  const sessionProject = route.screen === 'workflow' ? route.run.ref.projectDir : null;
  const sessionId = route.screen === 'workflow' ? route.run.ref.sessionId : null;
  const localExecution =
    route.screen === 'workflow' && route.execution.kind === 'local'
      ? route.execution.prepared
      : null;
  useEffect(() => {
    clearQuitHint();
    return clearQuitHint;
  }, [route.screen, sessionProject, sessionId]);
  useEffect(() => {
    if (localExecution !== null) clearQuitHint();
  }, [localExecution]);
  useEffect(
    () =>
      stopStore.subscribe(() => {
        if (stopStore.get().intent === 'none') clearQuitHint();
      }),
    [],
  );

  useEffect(() => {
    const stdin = getActiveFilteredStdin()?.stdin;
    if (!stdin) return;
    const onCopyKey = (result: Promise<CopyOutcome | undefined>) => {
      clearQuitHint();
      const revision = copyRevision.current;
      const feedback = feedbackStore.get();
      void result.then((outcome) => {
        if (
          outcome === undefined ||
          copyRevision.current !== revision ||
          feedbackStore.get() !== feedback
        )
          return;
        if (outcome === 'unavailable') feedbackStore.setError(formatCopyResult(outcome));
        else feedbackStore.setMessage(formatCopyResult(outcome));
      });
    };
    stdin.on('selection-copy', onCopyKey);
    return () => {
      copyRevision.current++;
      stdin.off('selection-copy', onCopyKey);
    };
  }, []);

  useInput((input, key) => {
    copyRevision.current++;
    const keys = ctrlCKeys(input, key);
    if (!keys.includes('press')) {
      clearQuitHint();
      return;
    }
    if (getActiveFilteredStdin()?.isPasteActive()) return;
    for (const pressed of keys) {
      if (pressed === 'other') {
        clearQuitHint();
        continue;
      }
      const phase = stopStore.get().phase;
      const stopping =
        stoppedOrStopping() && phase !== 'parked' && phase !== 'ended' && phase !== 'failed';
      if (quitUntil.current > Date.now() || stopping) {
        clearQuitHint();
        deps.requestQuit(exitOnce);
        return;
      }
      armQuit();
      if (
        route.screen === 'workflow' &&
        route.execution.kind !== 'at-rest' &&
        !stoppedOrStopping()
      ) {
        if (overlayStore.get().active === 'stop-sheet') overlayStore.close();
        deps.requestStopNow();
      }
    }
  });

  useInput(
    (input, key) => {
      if (!key.escape) return;
      // A pasted blob can carry a raw `\x1b`; ignore it while a bracketed paste is in flight.
      if (getActiveFilteredStdin()?.isPasteActive()) return;
      if (
        (route.screen === 'workflow' && route.execution.kind === 'at-rest') ||
        stoppedOrStopping() ||
        lifecycleStore.get().status === 'paused'
      ) {
        runDeferredEscape(input, goHome, goHome);
        return;
      }
      if (stopSheetReachable()) {
        runDeferredEscape(
          input,
          () => {
            deps.requestStopNow();
            if (input.length > 1 && input.split('').every((char) => char === '\x1b'))
              requestLeaveSession();
          },
          openStopSheet,
        );
        return;
      }
      if (!lifecycleStore.get().cancelled) return;
      runDeferredEscape(input, goHome, goHome);
    },
    {
      isActive:
        route.screen === 'workflow' &&
        !isOpen &&
        !overlayExclusive &&
        !promptPending &&
        !completionOpen &&
        !sessionPreparationActive &&
        !fieldSessionOwned,
    },
  );

  // Any non-ESC byte cancels a deferred arm: it means the prior `\x1b` was the head
  // of a split escape sequence (e.g. an arrow key over a slow link), not a lone press.
  useInput((_input, key) => {
    if (!key.escape) cancelEscapeAction();
  });

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (overlayActive === 'stop-sheet') {
        overlayStore.close();
        if (
          stoppedOrStopping() ||
          (route.screen === 'workflow' && route.execution.kind === 'at-rest')
        )
          requestLeaveSession();
        else deps.requestStopNow();
        return;
      }
      overlayStore.close();
    },
    { isActive: isOpen && !overlayExclusive && overlayClosesOnGlobalEscape },
  );

  useInput(
    (input, key) => {
      const shortcut = handleShortcutKeys(input, key, route);
      if (shortcut.type !== 'none') {
        applyAction(shortcut, exitOnce, deps);
        return;
      }
    },
    {
      isActive: !isOpen && !promptPending && !sessionPreparationActive && !fieldSessionOwned,
    },
  );
}

function handleShortcutKeys(
  input: string,
  key: Key,
  route: ReturnType<typeof routerStore.get>,
): AppKeyAction {
  const screen = route.screen;
  if (key.ctrl && input === 'k') return { type: 'open-overlay', overlay: 'command-palette' };
  if (key.ctrl && input === 's' && screen === 'home')
    return { type: 'open-overlay', overlay: 'skills' };
  if (input === '\x1f' || (key.ctrl && input === '/'))
    return { type: 'open-overlay', overlay: 'help' };
  if (key.ctrl && input === ',') return { type: 'open-overlay', overlay: 'settings' };
  if (key.ctrl && input === 'q') return { type: 'quit' };
  return NONE;
}

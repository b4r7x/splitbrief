import { useInput, type Key } from 'ink';
import { overlayStore } from '../stores/ui/overlay.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { composerLiveStore } from '../stores/ui/composer-live.js';
import { feedbackStore } from '../stores/ui/feedback.js';
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
import { requestQuit, requestStopNow } from '../features/workflow/handlers.js';
import { sessionSelectStore } from '../stores/navigation/session-select.js';
import { refreshSkills } from './refresh-skills.js';

type AppKeyAction =
  | { type: 'none' }
  | { type: 'exit' }
  | { type: 'quit' }
  | { type: 'open-overlay'; overlay: OverlayType };

const NONE: AppKeyAction = { type: 'none' };

/** What esc says when the composer holds text: the run is untouched and so is the draft. */
export const DRAFT_ESCAPE_HINT = 'clear the draft or ctrl+c to stop now';

// Help renders no Escape handler of its own and relies on this global close. Every other overlay
// closes itself on Escape, so the global handler must stand down once one of them sits on a
// non-empty stack — otherwise a single Escape would fire both handlers and pop past the parent
// (e.g. a runner picker opened from settings would skip settings and close outright).
const GLOBAL_ESC_OVERLAYS = new Set<OverlayType>(['help']);

// These overlays handle Escape themselves — the runner pickers give it a meaning beyond closing
// (a non-empty filter query clears first, only a second press exits). The global close must stand
// down for them even on an empty stack, or one press would fire both handlers.
const SELF_ESC_OVERLAYS = new Set<OverlayType>(SEAT_PICKER_OVERLAYS);

interface UseAppKeysOptions {
  exit: () => void;
}

function applyAction(action: AppKeyAction, exit: () => void) {
  switch (action.type) {
    case 'none':
      return;
    case 'exit':
      exit();
      return;
    case 'quit':
      requestQuit(exit);
      return;
    case 'open-overlay':
      // Discovery otherwise runs only at startup, so a skill directory added mid-session would
      // stay invisible until a restart. Rescanning here rather than on the picker's mount keeps
      // the scan off the render path the visual fixtures drive.
      if (action.overlay === 'skills') void refreshSkills();
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
  return status === 'running' || status === 'interrupted' || status === 'paused';
}

function openStopSheet(): void {
  overlayStore.open('stop-sheet');
}

function goHome(): void {
  routerStore.navigate({ to: 'home' });
}

function isSecondEscapePress(input: string): boolean {
  return input === '\x1b' || isEscapeActionPending();
}

function runDeferredEscape(input: string, immediate: () => void, deferred: () => void): void {
  if (isSecondEscapePress(input)) {
    cancelEscapeAction();
    immediate();
    return;
  }
  scheduleEscapeAction(deferred);
}

export function useAppKeys({ exit }: UseAppKeysOptions) {
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

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    // Ctrl+C is Stop now on the workflow screen — one press, no armed window. Where there is no
    // run left to stop it keeps its usual meaning and leaves.
    // A run at rest has no process to stop, so the chord keeps its usual meaning and leaves.
    if (
      route.screen !== 'workflow' ||
      route.execution.kind === 'at-rest' ||
      lifecycleStore.get().cancelled
    ) {
      exit();
      return;
    }
    if (!requestStopNow()) exit();
  });

  useInput(
    (input, key) => {
      if (!key.escape) return;
      // A pasted blob can carry a raw `\x1b`; ignore it while a bracketed paste is in flight.
      if (getActiveFilteredStdin()?.isPasteActive()) return;
      // Text in the composer is the user's, and so is the run behind it: the press spends neither.
      if (!composerLiveStore.get().empty) {
        feedbackStore.setMessage(DRAFT_ESCAPE_HINT);
        return;
      }
      // Nothing is running on a run at rest: the press leaves rather than offering to stop it.
      if (route.screen === 'workflow' && route.execution.kind === 'at-rest') {
        runDeferredEscape(input, goHome, goHome);
        return;
      }
      if (stopSheetReachable()) {
        runDeferredEscape(input, openStopSheet, openStopSheet);
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
      if (key.escape) overlayStore.close();
    },
    { isActive: isOpen && !overlayExclusive && overlayClosesOnGlobalEscape },
  );

  useInput(
    (input, key) => {
      const shortcut = handleShortcutKeys(input, key, route);
      if (shortcut.type !== 'none') {
        applyAction(shortcut, exit);
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

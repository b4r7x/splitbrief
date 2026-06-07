import { useInput, type Key } from 'ink';
import { overlayStore } from '../stores/ui/overlay.js';
import { routerStore } from '../stores/navigation/router.js';
import { controlsStore } from '../stores/ui/controls.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { abortStore } from '../stores/workflow/abort.js';
import { approvalPromptStore } from '../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../stores/cost-approval/prompt.js';
import { killAllProcesses } from '../lib/process/registry.js';
import { getActiveFilteredStdin } from '../lib/terminal/filtered-stdin.js';
import {
  scheduleEscapeAction,
  cancelEscapeAction,
  isEscapeActionPending,
} from '../lib/terminal/escape-debounce.js';
import {
  requestWorkflowCancel,
  type InterruptResult,
} from '../features/workflow/app-integration.js';
import { isLivePhase } from '../core/phases.js';
import { useStores } from '../stores/use-stores.js';
import { assertNever } from '../utils/type-guards.js';
import type { OverlayType, Screen } from '../core/navigation/types.js';

type AppKeyAction =
  | { type: 'none' }
  | { type: 'exit' }
  | { type: 'open-overlay'; overlay: OverlayType };

const NONE: AppKeyAction = { type: 'none' };
const noop = () => 'none' as const;

interface UseAppKeysOptions {
  exit: () => void;
  interruptWorkflow?: (() => InterruptResult) | undefined;
}

function applyAction(action: AppKeyAction, exit: () => void) {
  switch (action.type) {
    case 'none':
      return;
    case 'exit':
      exit();
      return;
    case 'open-overlay':
      overlayStore.open(action.overlay);
      return;
    default:
      return assertNever(action);
  }
}

// What an ESC press would arm to, given the current workflow state.
function escapeArmTarget(): 'interrupt' | 'cancel' | null {
  if (controlsStore.get().inputMode === 'question') return 'cancel';
  const { phase, cancelled } = lifecycleStore.get();
  if (!cancelled && isLivePhase(phase)) return 'interrupt';
  return null;
}

function fireInterrupt(interruptWorkflow: () => InterruptResult) {
  cancelEscapeAction();
  interruptWorkflow();
  killAllProcesses();
  abortStore.clear();
}

function fireCancel() {
  cancelEscapeAction();
  requestWorkflowCancel();
  abortStore.clear();
}

export function useAppKeys({ exit, interruptWorkflow = noop }: UseAppKeysOptions) {
  const [route, overlay, approval, cost] = useStores(
    routerStore,
    overlayStore,
    approvalPromptStore,
    costApprovalStore,
  );
  const { active: overlayActive, exclusive: overlayExclusive } = overlay;
  const isOpen = overlayActive !== 'none';
  const overlayHasStack = overlay.stack.length > 0;
  const promptPending = approval.status === 'pending' || cost.status === 'pending';

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    // Off the workflow screen there is no local turn to interrupt, and an attach client is a
    // thin remote viewer that mirrors a workflow running elsewhere — neither has anything to
    // arm against, so Ctrl+C exits immediately rather than starting a hidden two-press ladder.
    if (route.screen !== 'workflow' || route.attach) {
      exit();
      return;
    }
    if (abortStore.get().armed === 'exit') {
      exit();
      return;
    }
    const { phase, cancelled } = lifecycleStore.get();
    if (!cancelled && isLivePhase(phase)) {
      fireInterrupt(interruptWorkflow);
    }
    abortStore.arm('exit');
  });

  useInput(
    (input, key) => {
      if (!key.escape) return;
      // A pasted blob can carry a raw `\x1b`; ignore it while a bracketed paste is in flight.
      if (getActiveFilteredStdin()?.isPasteActive()) return;
      const armed = abortStore.get().armed;
      if (armed === 'interrupt') {
        fireInterrupt(interruptWorkflow);
        return;
      }
      if (armed === 'cancel') {
        fireCancel();
        return;
      }
      // A fresh ESC after the run was cancelled navigates home. This sits below the
      // armed-fire returns above, so the press that fires the cancel can never also
      // navigate — one physical keypress is at most one semantic action.
      if (lifecycleStore.get().cancelled) {
        // Defer like the arm path so a split escape sequence (`\x1b` then `[A` over a slow
        // link) can cancel the navigation via the non-ESC handler before it fires. A batched
        // double ESC or a second lone ESC while the first is still deferred navigates at once.
        const secondPress = input === '\x1b' || isEscapeActionPending();
        if (secondPress) {
          cancelEscapeAction();
          routerStore.navigate({ to: 'home' });
        } else {
          scheduleEscapeAction(() => routerStore.navigate({ to: 'home' }));
        }
        return;
      }
      const target = escapeArmTarget();
      if (target === null) return;
      // A second ESC fires immediately: either Ink 6.8 batched `\x1b\x1b` into one
      // event (leftover ESC in `input`), or a fresh lone ESC arrived while the first
      // press's arm was still deferred — two ESC bytes back to back can only be a real
      // double-press, never a split escape sequence (those continue with `[`, not ESC).
      const secondPress = input === '\x1b' || isEscapeActionPending();
      if (secondPress) {
        if (target === 'interrupt') fireInterrupt(interruptWorkflow);
        else fireCancel();
        return;
      }
      // First press: defer arming so a split escape sequence (`\x1b` then `[A`) can
      // cancel it before the hint appears. Armed-fire paths above react instantly.
      scheduleEscapeAction(() => abortStore.arm(target));
    },
    {
      isActive:
        route.screen === 'workflow' &&
        !isOpen &&
        !overlayExclusive &&
        !promptPending &&
        !route.attach,
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
    { isActive: isOpen && !overlayExclusive && !overlayHasStack },
  );

  useInput(
    (input, key) => {
      const shortcut = handleShortcutKeys(input, key, route.screen);
      if (shortcut.type !== 'none') {
        applyAction(shortcut, exit);
        return;
      }
    },
    { isActive: !isOpen },
  );
}

function handleShortcutKeys(input: string, key: Key, screen: Screen): AppKeyAction {
  if (key.ctrl && input === 'k') return { type: 'open-overlay', overlay: 'command-palette' };
  if (key.ctrl && input === 's' && screen === 'home')
    return { type: 'open-overlay', overlay: 'skills' };
  if (input === '\x1f') return { type: 'open-overlay', overlay: 'help' }; // Ctrl+/
  if (key.ctrl && input === ',') return { type: 'open-overlay', overlay: 'settings' };
  if (key.ctrl && input === 'q') return { type: 'exit' };
  return NONE;
}

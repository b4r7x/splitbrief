import { useInput, type Key } from 'ink';
import { overlayStore } from '../stores/ui/overlay.js';
import { routerStore } from '../stores/navigation/router.js';
import { controlsStore } from '../stores/ui/controls.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { abortStore } from '../stores/workflow/abort.js';
import { approvalPromptStore, closeApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import { costApprovalStore, closeCostApprovalPrompt } from '../stores/cost-approval/prompt.js';
import { completionStore } from '../stores/ui/completion.js';
import { killAllProcesses } from '../lib/process/registry.js';
import { getActiveFilteredStdin } from '../lib/terminal/filtered-stdin.js';
import {
  scheduleEscapeAction,
  cancelEscapeAction,
  isEscapeActionPending,
} from '../lib/terminal/escape-debounce.js';
import { isLivePhase } from '../core/phases.js';
import { useStores } from '../stores/use-stores.js';
import { assertNever } from '../utils/type-guards.js';
import type { OverlayType } from '../core/navigation/types.js';
import type { InterruptResult } from '../features/workflow/handlers.js';

type AppKeyAction =
  | { type: 'none' }
  | { type: 'exit' }
  | { type: 'open-overlay'; overlay: OverlayType };

const NONE: AppKeyAction = { type: 'none' };
const noop = () => 'none' as const;

// Help and the cost drilldown render no Escape handler of their own and rely on this global close.
// Every other overlay closes itself on Escape, so the global handler must stand down once one of
// them sits on a non-empty stack — otherwise a single Escape would fire both handlers and pop past
// the parent (e.g. a runner picker opened from settings would skip settings and close outright).
const GLOBAL_ESC_OVERLAYS = new Set<OverlayType>(['help', 'cost-drilldown']);

interface UseAppKeysOptions {
  exit: () => void;
  interruptWorkflow?: (() => InterruptResult) | undefined;
  cancelWorkflow?: (() => void) | undefined;
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
  closeApprovalPrompt();
  closeCostApprovalPrompt({ approved: false });
  abortStore.clear();
}

function fireCancel(cancelWorkflow: () => void) {
  cancelEscapeAction();
  cancelWorkflow();
  closeApprovalPrompt();
  closeCostApprovalPrompt({ approved: false });
  abortStore.clear();
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

export function useAppKeys({
  exit,
  interruptWorkflow = noop,
  cancelWorkflow = noop,
}: UseAppKeysOptions) {
  const [route, overlay, approval, cost, completion] = useStores(
    routerStore,
    overlayStore,
    approvalPromptStore,
    costApprovalStore,
    completionStore,
  );
  const { active: overlayActive, exclusive: overlayExclusive } = overlay;
  const isOpen = overlayActive !== 'none';
  const overlayHasStack = overlay.stack.length > 0;
  const overlayClosesOnGlobalEscape = !overlayHasStack || GLOBAL_ESC_OVERLAYS.has(overlayActive);
  const promptPending = approval.status === 'pending' || cost.status === 'pending';
  const completionOpen = completion.open;

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
        fireCancel(cancelWorkflow);
        return;
      }
      // A fresh ESC after the run was cancelled navigates home. This sits below the
      // armed-fire returns above, so the press that fires the cancel can never also
      // navigate — one physical keypress is at most one semantic action.
      if (lifecycleStore.get().cancelled) {
        runDeferredEscape(
          input,
          () => routerStore.navigate({ to: 'home' }),
          () => routerStore.navigate({ to: 'home' }),
        );
        return;
      }
      const target = escapeArmTarget();
      if (target === null) return;
      runDeferredEscape(
        input,
        () => {
          if (target === 'interrupt') fireInterrupt(interruptWorkflow);
          else fireCancel(cancelWorkflow);
        },
        () => abortStore.arm(target),
      );
    },
    {
      isActive:
        route.screen === 'workflow' &&
        !isOpen &&
        !overlayExclusive &&
        !promptPending &&
        !completionOpen &&
        !route.attach,
    },
  );

  useInput(
    (input, key) => {
      if (!key.escape) return;
      if (getActiveFilteredStdin()?.isPasteActive()) return;
      runDeferredEscape(
        input,
        () => routerStore.navigate({ to: 'home' }),
        () => routerStore.navigate({ to: 'home' }),
      );
    },
    {
      isActive:
        route.screen === 'summary' &&
        !isOpen &&
        !overlayExclusive &&
        !promptPending &&
        !completionOpen,
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
    { isActive: !isOpen && !promptPending },
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
    return { type: 'open-overlay', overlay: 'help' }; // Ctrl+/
  if (key.ctrl && input === ',') {
    if (route.screen === 'workflow' && route.attach !== undefined) return NONE;
    return { type: 'open-overlay', overlay: 'settings' };
  }
  if (key.ctrl && input === 'q') return { type: 'exit' };
  return NONE;
}

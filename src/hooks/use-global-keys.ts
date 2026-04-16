import { useRef } from 'react';
import { useInput, type Key } from 'ink';
import { overlayStore } from '../stores/overlay.js';
import { routerStore } from '../stores/router.js';
import { feedbackStore } from '../stores/feedback.js';
import { workflowStore } from '../stores/workflow.js';
import { abortStore } from '../stores/abort.js';
import { reviewStore } from '../stores/review.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { inputModeStore } from '../stores/input-mode.js';
import {
  readConversationScrollSnapshot,
  readReviewContentHeight,
} from '../core/conversation-layout-snapshot.js';
import { killAllProcesses } from '../utils/process-lifecycle.js';
import { isLivePhase } from '../core/phases.js';
import { findLatestRenderableDiffEventIndex } from '../core/event-sections.js';
import { terminalSizeStore } from '../stores/terminal-size.js';
import { assertNever } from '../utils/type-guards.js';
import type { KeyAction } from './keyboard-handlers.js';
import {
  handleShortcutKeys,
  handleWorkflowEscape,
  handleWorkflowCtrlChords,
  handleReviewScroll,
  handleConversationScroll,
} from './keyboard-handlers.js';

const DOUBLE_PRESS_WINDOW_MS = 2000;

function applyAction(action: KeyAction, exit: () => void) {
  switch (action.type) {
    case 'none': return;
    case 'exit': exit(); return;
    case 'navigate': routerStore.navigate(action.screen); return;
    case 'open-overlay': overlayStore.open(action.overlay); return;
    case 'toggle-sidebar': workflowStore.toggleSidebar(); return;
    case 'toggle-diff': conversationScrollStore.toggleDiff(action.index); return;
    case 'review-scroll': reviewStore.setScrollOffset(action.offset); return;
    case 'conversation-scroll-up': conversationScrollStore.scrollUp({ renderableCount: action.renderableCount, totalHeight: action.totalHeight, step: action.step }); return;
    case 'conversation-scroll-down': conversationScrollStore.scrollDown(action.step); return;
    case 'conversation-scroll-bottom': conversationScrollStore.scrollToBottom(action.renderableCount); return;
    default: return assertNever(action);
  }
}

function getWorkflowScrollAction(input: string, key: Key): KeyAction {
  const review = reviewStore.get();

  if (review.filePath) {
    const visibleHeight = readReviewContentHeight();
    return handleReviewScroll(input, key, review.scrollOffset, review.lineCount, visibleHeight);
  }

  const { maxOffset, renderableCount, totalHeight, viewportHeight } = readConversationScrollSnapshot();
  return handleConversationScroll(
    input,
    key,
    renderableCount,
    maxOffset,
    viewportHeight,
    totalHeight,
  );
}

export function useGlobalKeys({ exit }: { exit: () => void }) {
  const screen = routerStore.use(s => s.screen);
  const overlayActive = overlayStore.use(s => s.active);
  const isOpen = overlayActive !== 'none';
  const overlayExclusive = overlayStore.use(s => s.exclusive);
  const overlayHasStack = overlayStore.use(s => s.stack.length > 0);
  const lastCtrlCRef = useRef(0);
  const isSmall = terminalSizeStore.use(s => s.isSmall);

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    if (Date.now() - lastCtrlCRef.current < DOUBLE_PRESS_WINDOW_MS) {
      exit();
      return;
    }
    if (screen === 'workflow') {
      const { phase, cancelled } = workflowStore.get();
      if (!cancelled && isLivePhase(phase)) {
        lastCtrlCRef.current = Date.now();
        abortStore.markPending();
        workflowStore.abortTurn();
        killAllProcesses();
        feedbackStore.setMessage('Aborting… Ctrl+C again to exit');
      } else {
        exit();
      }
    } else {
      exit();
    }
  });

  useInput(
    (_input, key) => {
      if (key.escape) overlayStore.close();
    },
    { isActive: isOpen && !overlayExclusive && !overlayHasStack },
  );

  useInput(
    (input, key) => {
      if (key.escape && screen === 'workflow') {
        const { cancelled } = workflowStore.get();
        const action = handleWorkflowEscape(key, cancelled);
        if (action.type !== 'none') { applyAction(action, exit); return; }
      }

      const shortcut = handleShortcutKeys(input, key, screen);
      if (shortcut.type !== 'none') { applyAction(shortcut, exit); return; }

      if (screen === 'workflow') {
        const workflow = workflowStore.get();

        const chord = handleWorkflowCtrlChords(input, key, isSmall, workflow.sections, findLatestRenderableDiffEventIndex);
        if (chord.type !== 'none') { applyAction(chord, exit); return; }

        if (inputModeStore.get().interactive) return;

        const scroll = getWorkflowScrollAction(input, key);
        if (scroll.type !== 'none') { applyAction(scroll, exit); return; }
      }
    },
    { isActive: !isOpen },
  );
}

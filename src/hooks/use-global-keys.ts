import { useRef } from 'react';
import { useInput } from 'ink';
import { overlayStore } from '../stores/overlay.js';
import { routerStore } from '../stores/router.js';
import { feedbackStore } from '../stores/feedback.js';
import { workflowStore } from '../stores/workflow.js';
import { reviewStore } from '../stores/review.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { inputModeStore } from '../stores/input-mode.js';
import { killAllProcesses } from '../utils/process-lifecycle.js';
import { CANCELLABLE_PHASES } from '../core/phases.js';
import { findLatestDiffEventIndex } from '../components/conversation-flow/section-heights.js';
import { terminalSizeStore } from '../stores/terminal-size.js';
import type { KeyAction } from './keyboard-handlers.js';
import {
  handleShortcutKeys,
  handleWorkflowEscape,
  handleWorkflowCtrlChords,
  handleReviewScroll,
  handleConversationScroll,
} from './keyboard-handlers.js';

const DOUBLE_PRESS_WINDOW_MS = 3000;
const CHROME_HEIGHT = 10;

function applyAction(action: KeyAction, exit: () => void) {
  switch (action.type) {
    case 'none': return;
    case 'exit': exit(); return;
    case 'cancel-workflow': if (workflowStore.requestCancel()) { try { killAllProcesses(); } catch { /* best-effort */ } } return;
    case 'navigate': routerStore.navigate(action.screen); return;
    case 'open-overlay': overlayStore.open(action.overlay); return;
    case 'toggle-sidebar': workflowStore.toggleSidebar(); return;
    case 'toggle-diff': conversationScrollStore.toggleDiff(action.index); return;
    case 'review-scroll': reviewStore.setScrollOffset(action.offset); return;
    case 'conversation-scroll-up': conversationScrollStore.scrollUp(action.maxOffset, action.eventCount); return;
    case 'conversation-scroll-down': conversationScrollStore.scrollDown(); return;
    case 'conversation-scroll-bottom': conversationScrollStore.scrollToBottom(action.eventCount); return;
  }
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
    lastCtrlCRef.current = Date.now();
    if (screen === 'workflow') {
      const { cancelled } = workflowStore.get();
      if (!cancelled) {
        if (workflowStore.requestCancel()) {
          try { killAllProcesses(); } catch { /* best-effort */ }
        }
      } else {
        killAllProcesses();
      }
      feedbackStore.setError('Cancelling workflow... Ctrl+C to exit');
    } else {
      feedbackStore.setError('Press Ctrl+C again to exit');
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
        const { phase, cancelled } = workflowStore.get();
        const action = handleWorkflowEscape(key, cancelled, phase, CANCELLABLE_PHASES);
        if (action.type !== 'none') { applyAction(action, exit); return; }
      }

      const shortcut = handleShortcutKeys(input, key, screen);
      if (shortcut.type !== 'none') { applyAction(shortcut, exit); return; }

      if (screen === 'workflow') {
        const events = workflowStore.get().events;

        const chord = handleWorkflowCtrlChords(input, key, isSmall, events, findLatestDiffEventIndex);
        if (chord.type !== 'none') { applyAction(chord, exit); return; }

        if (inputModeStore.get().interactive) return;

        const review = reviewStore.get();
        if (review.filePath) {
          const visibleHeight = terminalSizeStore.get().rows - CHROME_HEIGHT;
          const reviewAction = handleReviewScroll(input, key, review.scrollOffset, review.lineCount, visibleHeight);
          if (reviewAction.type !== 'none') { applyAction(reviewAction, exit); return; }
        }

        const scroll = handleConversationScroll(input, key, events.length);
        if (scroll.type !== 'none') { applyAction(scroll, exit); return; }
      }
    },
    { isActive: !isOpen },
  );
}

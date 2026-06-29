import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wireAppMouse } from './mouse.js';
import type { FilteredStdin, MouseEvent } from '../lib/terminal/filtered-stdin.js';
import { _resetMouseZones, registerMouseZone } from '../lib/terminal/mouse-zones.js';
import { ROW_ZONE_Z_OVERLAY, ROW_ZONE_Z_SCREEN } from '../components/pickers/row-zone.js';
import { PROMPT_ZONE_Z } from '../features/workflow/components/approval-prompt.js';
import { briefListTopOffset } from '../features/workflow/layout/hit-test.js';
import { readBriefListSnapshot } from '../features/workflow/layout/snapshot.js';
import { _resetHoverThrottle } from '../features/workflow/hooks/use-mouse-pointer.js';
import { routerStore } from '../stores/navigation/router.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { hoverStore } from '../stores/ui/hover.js';
import { focusStore } from '../stores/ui/focus.js';
import { controlsStore } from '../stores/ui/controls.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { inputHeightStore } from '../stores/ui/input-height.js';
import { approvalPromptStore } from '../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../stores/cost-approval/prompt.js';
import { reviewStore } from '../stores/workflow/review.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../stores/workflow/events.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { resetWorkflow } from '../stores/workflow/actions.js';
import type { TieredApprovalRequest } from '../core/approval/types.js';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';

function createMockFilteredStdin() {
  let listener: ((event: MouseEvent) => void) | undefined;
  return {
    filtered: {
      stdin: process.stdin as unknown as NodeJS.ReadStream,
      onMouse: (next: (event: MouseEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      activate: () => {},
      isPasteActive: () => false,
      disable: () => {},
    } satisfies FilteredStdin,
    emit: (event: MouseEvent) => listener?.(event),
  };
}

function pointerEvent(type: MouseEvent['type'], x: number, y: number): MouseEvent {
  const button = type === 'wheel-up' ? 64 : type === 'wheel-down' ? 65 : type === 'move' ? 3 : 0;
  return { type, x, y, button, shift: false, meta: false, ctrl: false };
}

function makePendingApprovalRequest(): TieredApprovalRequest {
  return {
    tier: 'confirm',
    actionClass: 'destructive',
    actionDescription: 'rm -rf /',
    phase: 'implementing',
  };
}

function seedConversation(): void {
  eventsStore.__testReset({
    events: Array.from({ length: 20 }, (_, ts) => ({
      type: 'planner_text' as const,
      ts,
      phase: 'specifying' as const,
      text: `event-${ts}`,
    })),
  });
}

function openBriefReview(taskCount: number) {
  routerStore.init({ screen: 'workflow', feature: 'feat' });
  lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
  reviewStore.setReviewFile('briefs.md', taskCount);
  const snapshot = readBriefListSnapshot();
  if (snapshot === null) throw new Error('expected a brief-list snapshot');
  return snapshot;
}

describe('wireAppMouse', () => {
  beforeEach(() => {
    routerStore.reset();
    overlayStore.reset();
    reviewStore.reset();
    focusStore.clear();
    hoverStore.clear();
    terminalSizeStore.__testReset({ rows: 30, cols: 80, isSmall: false });
    conversationScrollStore.reset();
    resetWorkflow();
    inputHeightStore.reset();
    lifecycleStore.__testReset();
    controlsStore.__testReset();
    approvalPromptStore.__testReset();
    costApprovalStore.__testReset();
    _resetMouseZones();
    _resetHoverThrottle();
  });

  it('routes clicks only to overlay-layer zones while an overlay is open', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    const screenClick = vi.fn();
    registerMouseZone({
      id: 'screen-row',
      left: 1,
      right: 80,
      top: 5,
      bottom: 5,
      z: ROW_ZONE_Z_SCREEN,
      onClick: screenClick,
    });
    const overlayClick = vi.fn();
    registerMouseZone({
      id: 'overlay-row',
      left: 1,
      right: 80,
      top: 5,
      bottom: 5,
      z: ROW_ZONE_Z_OVERLAY,
      onClick: overlayClick,
    });
    overlayStore.open('command-palette');
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    mock.emit(pointerEvent('press', 10, 5));

    expect(overlayClick).toHaveBeenCalledOnce();
    expect(screenClick).not.toHaveBeenCalled();
    dispose();
  });

  it('routes clicks on non-workflow screens to registered zones and clears stale workflow hover', () => {
    hoverStore.set('conversation', 2);
    const click = vi.fn();
    registerMouseZone({
      id: 'home-row',
      left: 1,
      right: 80,
      top: 5,
      bottom: 5,
      z: ROW_ZONE_Z_SCREEN,
      onClick: click,
    });
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    mock.emit(pointerEvent('move', 10, 5));
    mock.emit(pointerEvent('press', 10, 5));

    expect(hoverStore.get()).toBeNull();
    expect(click).toHaveBeenCalledOnce();
    dispose();
  });

  it('routes prompt-owned clicks only to prompt-layer zones', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    approvalPromptStore.__testReset({
      status: 'pending',
      request: makePendingApprovalRequest(),
      resolve: () => {},
    });
    const composerClick = vi.fn();
    registerMouseZone({
      id: 'composer-hint',
      left: 1,
      right: 80,
      top: 6,
      bottom: 6,
      z: 5,
      onClick: composerClick,
    });
    const promptClick = vi.fn();
    registerMouseZone({
      id: 'approval-option-allow',
      left: 1,
      right: 80,
      top: 2,
      bottom: 2,
      z: PROMPT_ZONE_Z,
      onClick: promptClick,
    });
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    mock.emit(pointerEvent('press', 10, 6));
    mock.emit(pointerEvent('press', 10, 2));

    expect(composerClick).not.toHaveBeenCalled();
    expect(promptClick).toHaveBeenCalledOnce();
    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('blocks workflow fallback hit testing while question input owns the prompt', () => {
    const snapshot = openBriefReview(12);
    controlsStore.setInputMode('question');
    const listTop = snapshot.rect.top + briefListTopOffset({ hasLoadError: false });
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    mock.emit(pointerEvent('press', snapshot.rect.left, listTop));

    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('ignores workflow wheel input while overlays or prompts own input', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    seedConversation();
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    overlayStore.open('cost-drilldown');
    mock.emit(pointerEvent('wheel-up', 2, 7));
    overlayStore.close();
    approvalPromptStore.__testReset({
      status: 'pending',
      request: makePendingApprovalRequest(),
      resolve: () => {},
    });
    mock.emit(pointerEvent('wheel-up', 2, 7));
    approvalPromptStore.__testReset();
    costApprovalStore.__testReset({
      status: 'pending',
      prediction: makeCostPrediction(),
      resolve: () => {},
    });
    mock.emit(pointerEvent('wheel-up', 2, 7));

    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    dispose();
  });
});

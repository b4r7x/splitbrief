import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wireAppMouse } from '../../../src/app/mouse.js';
import type { FilteredStdin, MouseEvent } from '../../../src/lib/terminal/filtered-stdin/types.js';
import { _resetMouseZones, registerMouseZone } from '../../../src/lib/terminal/mouse-zones.js';
import { ROW_ZONE_Z_OVERLAY, ROW_ZONE_Z_SCREEN } from '../../../src/components/pickers/row-zone.js';
import { PROMPT_ZONE_Z } from '../../../src/features/workflow/components/approval-prompt.js';
import { readBriefListSnapshot } from '../../../src/features/workflow/layout/snapshot.js';
import { _resetHoverThrottle } from '../../../src/features/workflow/hooks/use-mouse-pointer.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { hoverStore } from '../../../src/stores/ui/hover.js';
import { focusStore } from '../../../src/stores/ui/focus.js';
import { controlsStore } from '../../../src/stores/ui/controls.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { inputHeightStore } from '../../../src/stores/ui/input-height.js';
import { approvalPromptStore } from '../../../src/stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../src/stores/cost-approval/prompt.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';
import { conversationScrollStore } from '../../../src/stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import type { TieredApprovalRequest } from '../../../src/core/approval/types.js';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';

const WORKFLOW_ROUTE = {
  screen: 'workflow',
  execution: {
    kind: 'attached',
    feature: 'feat',
    sessionId: 'app-mouse-session',
    attach: { sockPath: '/tmp/app-mouse.sock', authToken: 'test-token' },
  },
} as const;

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
  routerStore.init(WORKFLOW_ROUTE);
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
    editorStore.close();
  });

  it('routes clicks only to overlay-layer zones while an overlay is open', () => {
    routerStore.init(WORKFLOW_ROUTE);
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
    routerStore.init(WORKFLOW_ROUTE);
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
    const listTop = snapshot.rect.top + snapshot.taskTopOffset;
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    mock.emit(pointerEvent('press', snapshot.rect.left, listTop));

    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('blocks workflow fallback hit testing while a field-editor session owns input', () => {
    const snapshot = openBriefReview(12);
    editorStore.openField({
      filePath: 'briefs.md',
      value: 'title text',
      ownerToken: reviewStore.get().ownerToken,
      layout: { columns: 80, rows: 30 },
    });
    const listTop = snapshot.rect.top + snapshot.taskTopOffset;
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    mock.emit(pointerEvent('press', snapshot.rect.left, listTop));

    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('ignores workflow wheel input while overlays or prompts own input', () => {
    routerStore.init(WORKFLOW_ROUTE);
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
    costApprovalStore.__testReset();
    editorStore.openField({
      filePath: 'briefs.md',
      value: 'title text',
      ownerToken: 1,
      layout: { columns: 80, rows: 30 },
    });
    mock.emit(pointerEvent('wheel-up', 2, 7));

    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    dispose();
  });

  it('scrolls the raw editor overlay by one step per wheel event and clamps at the top', () => {
    editorStore.openRaw({
      filePath: 'spec.md',
      // Content must overflow the viewport (20 lines in 5 rows → maxTop 15) so wheel steps are not
      // clamped away: scrollBy bounds scrollTop to the wrapped document height (REQ-030), so a
      // fits-in-viewport buffer could never scroll and would mask per-event stepping.
      value: Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n'),
      ownerToken: 1,
      layout: { columns: 80, rows: 5 },
    });
    overlayStore.open('editor');
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    mock.emit(pointerEvent('wheel-down', 2, 7));
    expect(editorStore.get()).toMatchObject({ scrollTop: 1 });
    mock.emit(pointerEvent('wheel-down', 2, 7));
    expect(editorStore.get()).toMatchObject({ scrollTop: 2 });

    mock.emit(pointerEvent('wheel-up', 2, 7));
    expect(editorStore.get()).toMatchObject({ scrollTop: 1 });
    mock.emit(pointerEvent('wheel-up', 2, 7));
    mock.emit(pointerEvent('wheel-up', 2, 7));
    expect(editorStore.get()).toMatchObject({ scrollTop: 0 });

    dispose();
  });
});

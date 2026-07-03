import { beforeEach, describe, expect, it } from 'vitest';
import {
  readBriefListSnapshot,
  readConversationScrollSnapshot,
  readRailSnapshot,
  readReviewContentHeight,
} from './snapshot.js';
import { briefListTopOffset, hitBriefTaskRow } from './hit-test.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../stores/cost-approval/prompt.js';
import { questionPromptStore } from '../../../stores/question-prompt/prompt.js';
import { getApprovalPromptRows, getQuestionPromptRows } from '../prompt-rows.js';
import { getWorkflowContentWidth, getWorkflowViewportHeight } from './rect.js';
import { taskId } from '../../../core/schemas/task.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { makeTaskStart } from '#testing/helpers/events.js';

beforeEach(() => {
  terminalSizeStore.reset();
  inputHeightStore.reset();
  conversationScrollStore.reset();
  resetWorkflow();
  controlsStore.reset();
  reviewStore.reset();
  approvalPromptStore.reset();
  costApprovalStore.reset();
  questionPromptStore.reset();
});

function makeConfirmRequest(actionDescription: string): TieredApprovalRequest {
  return {
    tier: 'confirm',
    actionClass: 'destructive',
    actionDescription,
    phase: 'implementing',
  };
}

function makeLongTaskStarted(): Extract<EngineEvent, { type: 'task_started' }> {
  return makeTaskStart({
    ts: 0,
    taskId: taskId('T001'),
    title: 'No-op workflow demonstration with enough metadata to wrap',
    total: 1,
    file: 'README.md',
    tool: 'claude-code',
    model: 'sonnet',
    implementerProfile: 'default',
    contextFit: 'fits',
    estimatedTokens: 3911,
    contextLength: 32768,
    currentCodeContextMode: 'whole-file',
    costPosture: 'Selected unknown cost tier via cheapest-capable routing',
  });
}

describe('readConversationScrollSnapshot', () => {
  it('returns sensible defaults with empty stores', () => {
    const snap = readConversationScrollSnapshot();
    expect(snap.maxOffset).toBeGreaterThanOrEqual(0);
    expect(snap.renderableCount).toBeGreaterThanOrEqual(0);
    expect(snap.scrollOffset).toBeGreaterThanOrEqual(0);
    expect(snap.totalHeight).toBeGreaterThanOrEqual(0);
    expect(snap.viewportHeight).toBeGreaterThanOrEqual(0);
    expect(snap.contentRect).toBeDefined();
    expect(snap.contentRect.width).toBeGreaterThan(0);
  });

  it('reflects seeded terminal size in contentRect and viewportHeight', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    const snap = readConversationScrollSnapshot();
    // Default phase is idle: no stage is live, so the rail hangs no activity row.
    const fullBodyHeight = getWorkflowViewportHeight({
      rows: 40,
      inputRows: 3,
      promptRows: 0,
    });

    expect(snap.contentRect.width).toBe(160);
    expect(snap.conversationWidth).toBe(160);
    expect(snap.conversationRect.width).toBe(160);
    expect(snap.viewportHeight).toBe(fullBodyHeight);
    expect(snap.viewportHeight).toBeLessThan(40);
    expect(snap.conversationRect.top).toBe(snap.contentRect.top);
    expect(snap.conversationRect.height).toBe(snap.viewportHeight);
  });

  it('reduces viewportHeight on a small terminal', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: true });
    inputHeightStore.__testReset({ rows: 3 });

    const snap = readConversationScrollSnapshot();

    expect(snap.viewportHeight).toBeGreaterThanOrEqual(0);
    expect(snap.viewportHeight).toBeLessThan(20);
  });

  it('reserves no viewport row for the live status, which lives in the footer byline', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const active = readConversationScrollSnapshot();

    lifecycleStore.__testReset({ phase: 'idle' });
    const idle = readConversationScrollSnapshot();

    expect(active.viewportHeight).toBe(idle.viewportHeight);
    expect(active.totalHeight).toBe(idle.totalHeight);
  });

  it('subtracts dynamic prompt rows from the conversation viewport', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 40, isSmall: true });
    inputHeightStore.__testReset({ rows: 3 });

    const withoutPrompt = readConversationScrollSnapshot();
    const request = makeConfirmRequest('delete generated files');
    approvalPromptStore.__testReset({
      status: 'pending',
      request,
      resolve: () => undefined,
    });

    const withPrompt = readConversationScrollSnapshot();

    expect(withPrompt.viewportHeight).toBe(
      withoutPrompt.viewportHeight - getApprovalPromptRows(approvalPromptStore.get(), 80),
    );
  });

  it('subtracts question prompt rows from shared conversation and review geometry', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 40, isSmall: true });
    inputHeightStore.__testReset({ rows: 3 });
    reviewStore.setRenderedLineCount(0);

    const withoutPrompt = readConversationScrollSnapshot();
    const reviewWithoutPrompt = readReviewContentHeight();
    const hint = 'Question 1/1: Which API style should the implementation use?';

    questionPromptStore.setHint(hint);

    const withPrompt = readConversationScrollSnapshot();
    const reviewWithPrompt = readReviewContentHeight();
    const questionRows = getQuestionPromptRows(hint, 80);

    expect(withPrompt.viewportHeight).toBe(withoutPrompt.viewportHeight - questionRows);
    expect(reviewWithPrompt).toBe(reviewWithoutPrompt - questionRows);
  });

  it('recomputes prompt row budget when terminal width changes', () => {
    const request = makeConfirmRequest(
      'delete a generated artifact outside the active task scope after reviewing all safeguards',
    );
    approvalPromptStore.__testReset({
      status: 'pending',
      request,
      resolve: () => undefined,
    });

    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const wide = readConversationScrollSnapshot();

    terminalSizeStore.__testReset({ cols: 40, rows: 40, isSmall: true });
    const narrow = readConversationScrollSnapshot();

    expect(narrow.viewportHeight).toBeLessThan(wide.viewportHeight);
  });

  it('recomputes conversation row height when terminal width changes', () => {
    eventsStore.__testReset({ events: [makeLongTaskStarted()] });
    inputHeightStore.__testReset({ rows: 3 });

    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const wide = readConversationScrollSnapshot();

    terminalSizeStore.__testReset({ cols: 44, rows: 40, isSmall: true });
    const narrow = readConversationScrollSnapshot();

    expect(narrow.totalHeight).toBeGreaterThan(wide.totalHeight);
  });

  it('uses full content width for scroll calculations now that the activity rail is removed', () => {
    eventsStore.__testReset({ events: [makeLongTaskStarted()] });
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    const snap = readConversationScrollSnapshot();

    expect(snap.contentRect.width).toBe(120);
    expect(snap.conversationWidth).toBe(120);
    expect(snap.conversationRect.width).toBe(120);
    expect(snap.conversationRect.right).toBe(snap.conversationRect.left + 119);
  });

  it('sidebar presence narrows content width', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });

    const snapNoSidebar = readConversationScrollSnapshot();

    controlsStore.setSidebar(true);

    const snapWithSidebar = readConversationScrollSnapshot();

    expect(snapWithSidebar.contentRect.width).toBeLessThan(snapNoSidebar.contentRect.width);
  });

  it('scrollOffset stays within [0, maxOffset]', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    conversationScrollStore.__testReset({ scrollOffset: 999 });

    const snap = readConversationScrollSnapshot();

    expect(snap.scrollOffset).toBeGreaterThanOrEqual(0);
    expect(snap.scrollOffset).toBeLessThanOrEqual(snap.maxOffset);
  });
});

describe('readRailSnapshot', () => {
  it('returns clickable zones for the active streaming rail', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });

    const snap = readRailSnapshot();

    expect(snap.activeIndex).toBe(3);
    expect(snap.zones.length).toBeGreaterThan(0);
    expect(snap.zones.some((zone) => zone.index === 3)).toBe(true);
  });

  it('exposes only the active-stage zone in Form C at a narrow width', () => {
    terminalSizeStore.__testReset({ cols: 30, rows: 30, isSmall: true });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    // 28 content cells cannot fit the five-stage marker+connector line, so the rail drops to Form C.
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });

    const snap = readRailSnapshot();

    expect(snap.zones).toHaveLength(1);
    expect(snap.zones.every((zone) => zone.index === 3)).toBe(true);
  });

  it('selects the rail form from width alone, independent of the live fraction', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const live = readRailSnapshot();

    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'running',
      startedAt: 0,
      cancelled: true,
    });
    const cancelled = readRailSnapshot();

    expect(live.zones).toHaveLength(5);
    // The horizontal rail no longer paints the fraction inline, so dropping it (cancelled) can never
    // shift the trailing zones — the geometry mirrors rail.tsx.
    expect(
      cancelled.zones.map((zone) => ({ index: zone.index, left: zone.left, right: zone.right })),
    ).toEqual(
      live.zones.map((zone) => ({ index: zone.index, left: zone.left, right: zone.right })),
    );
  });
});

describe('readReviewContentHeight', () => {
  it('returns a positive height for a normal terminal with content', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    reviewStore.setRenderedLineCount(50);

    const height = readReviewContentHeight();

    expect(height).toBeGreaterThan(0);
  });

  it('accounts for scrollable content by reserving a footer row', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    reviewStore.setRenderedLineCount(1);
    const shortContent = readReviewContentHeight();

    reviewStore.setRenderedLineCount(1000);
    const tallContent = readReviewContentHeight();

    expect(tallContent).toBe(shortContent - 2);
  });
});

describe('readBriefListSnapshot phantom-hotspot clamp', () => {
  it('clamps the visible window to the rendered briefs on a tall terminal with few tasks', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'reviewing-briefs', status: 'running', startedAt: 0 });
    reviewStore.setRenderedLineCount(3);
    reviewStore.setScrollOffset(0);

    const snap = readBriefListSnapshot();
    if (!snap) throw new Error('expected a brief list snapshot while reviewing briefs');

    // Far fewer briefs than rows of budget — the window must not advertise more rows than exist.
    expect(snap.visibleCount).toBe(3);
    expect(snap.previousCount).toBe(0);

    const listTop = snap.rect.top + briefListTopOffset({ hasLoadError: false });
    const lastRowY = listTop + snap.visibleCount - 1;
    const belowLastRowY = lastRowY + 1;

    // The probe row sits inside the content rect but below the last rendered brief: still inert.
    expect(belowLastRowY).toBeLessThanOrEqual(snap.rect.bottom);
    expect(
      hitBriefTaskRow({
        rect: snap.rect,
        sgrX: snap.rect.left,
        sgrY: belowLastRowY,
        hasLoadError: false,
        visibleCount: snap.visibleCount,
        previousCount: snap.previousCount,
      }),
    ).toBeNull();
    expect(
      hitBriefTaskRow({
        rect: snap.rect,
        sgrX: snap.rect.left,
        sgrY: lastRowY,
        hasLoadError: false,
        visibleCount: snap.visibleCount,
        previousCount: snap.previousCount,
      }),
    ).toBe(2);
  });

  it('spans the full content pane on a wide terminal (no review column cap)', () => {
    terminalSizeStore.__testReset({ cols: 300, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'reviewing-briefs', status: 'running', startedAt: 0 });
    reviewStore.setRenderedLineCount(5);
    reviewStore.setScrollOffset(0);

    const snap = readBriefListSnapshot();
    if (!snap) throw new Error('expected a brief list snapshot while reviewing briefs');

    // The review column is no longer capped, so the brief card fills the whole content pane.
    const fullContentWidth = getWorkflowContentWidth({
      cols: 300,
      sidebarVisible: false,
      isSmall: false,
    });
    expect(fullContentWidth).toBeGreaterThan(120);
    expect(snap.rect.width).toBe(fullContentWidth);
    expect(snap.rect.right).toBe(snap.rect.left + fullContentWidth - 1);

    const listTop = snap.rect.top + briefListTopOffset({ hasLoadError: false });

    // The last painted column of the full-width card still resolves a brief row.
    expect(
      hitBriefTaskRow({
        rect: snap.rect,
        sgrX: snap.rect.right,
        sgrY: listTop,
        hasLoadError: false,
        visibleCount: snap.visibleCount,
        previousCount: snap.previousCount,
      }),
    ).toBe(0);

    // One column past the content pane is outside the card — clicking it must not focus or copy a
    // row.
    expect(
      hitBriefTaskRow({
        rect: snap.rect,
        sgrX: snap.rect.right + 1,
        sgrY: listTop,
        hasLoadError: false,
        visibleCount: snap.visibleCount,
        previousCount: snap.previousCount,
      }),
    ).toBeNull();
  });

  it('shifts the brief-list offset down by the error chrome row when a brief failed to load', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'reviewing-briefs', status: 'running', startedAt: 0 });
    reviewStore.setRenderedLineCount(3);
    reviewStore.setScrollOffset(0);
    reviewStore.setLoadError('Task Brief file is missing');

    const snap = readBriefListSnapshot();
    if (!snap) throw new Error('expected a brief list snapshot while reviewing briefs');

    // The snapshot carries the real error flag so the hit-test offset can track the rendered chrome.
    expect(snap.hasLoadError).toBe(true);

    // With the error line rendered, the first task row sits one screen line lower; feeding the
    // snapshot's own flag back into the hit-test maps that lower line to task 0.
    const listTop = snap.rect.top + briefListTopOffset({ hasLoadError: true });
    expect(
      hitBriefTaskRow({
        rect: snap.rect,
        sgrX: snap.rect.left,
        sgrY: listTop,
        hasLoadError: snap.hasLoadError,
        visibleCount: snap.visibleCount,
        previousCount: snap.previousCount,
      }),
    ).toBe(0);
    // The pre-error offset would land on the error line, not the first task: inert.
    expect(
      hitBriefTaskRow({
        rect: snap.rect,
        sgrX: snap.rect.left,
        sgrY: snap.rect.top + briefListTopOffset({ hasLoadError: false }),
        hasLoadError: snap.hasLoadError,
        visibleCount: snap.visibleCount,
        previousCount: snap.previousCount,
      }),
    ).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  readBriefListSnapshot,
  readConversationHoverSnapshot,
  readConversationScrollSnapshot,
  readRailSnapshot,
  readReviewContentHeight,
} from './snapshot.js';
import { briefListTopOffset, hitBriefTaskRow, hitTranscriptRow } from './hit-test.js';
import { getContentTopRow, getProgressRows, WORKFLOW_GUTTER_X } from './chrome-rows.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { questionPromptStore } from '../../../stores/question-prompt/prompt.js';
import { getApprovalPromptRows } from '../prompt-rows/approval.js';
import { getQuestionPromptRows } from '../prompt-rows/question.js';
import {
  getReviewContentLayout,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  REVIEW_FRAME_ROWS,
} from './rect.js';
import { taskId } from '../../../core/schemas/task.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { configStore } from '../../../stores/project/config.js';
import { modeAdviceStore } from '../../../stores/workflow/mode-advice.js';

beforeEach(() => {
  terminalSizeStore.reset();
  inputHeightStore.reset();
  conversationScrollStore.reset();
  resetWorkflow();
  controlsStore.reset();
  reviewStore.reset();
  approvalPromptStore.reset();
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
    routingReason: 'smallest capable context window',
  });
}

describe('readConversationScrollSnapshot', () => {
  it('derives the default viewport from the reset stores and pins the empty transcript at zero', () => {
    const snap = readConversationScrollSnapshot();
    expect(snap.viewportHeight).toBe(
      getWorkflowViewportHeight({
        rows: terminalSizeStore.get().rows,
        inputRows: inputHeightStore.get().rows,
        promptRows: 0,
      }),
    );
    expect(snap.contentRect.height).toBe(snap.viewportHeight);
    expect(snap.renderableCount).toBe(0);
    expect(snap.totalHeight).toBe(0);
    expect(snap.maxOffset).toBe(0);
    expect(snap.scrollOffset).toBe(0);
  });

  it('reflects seeded terminal size in contentRect and viewportHeight', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    controlsStore.setSidebar(false);

    const snap = readConversationScrollSnapshot();
    // Default phase is idle: no stage is live, so the rail hangs no activity row.
    const fullBodyHeight = getWorkflowViewportHeight({
      rows: 40,
      inputRows: 3,
      promptRows: 0,
    });

    expect(snap.contentRect.width).toBe(159);
    expect(snap.conversationWidth).toBe(159);
    expect(snap.viewportHeight).toBe(fullBodyHeight);
    expect(snap.viewportHeight).toBeLessThan(40);
    expect(snap.contentRect.height).toBe(snap.viewportHeight);

    // Rows alone drive the body height: the same terminal with fewer rows is strictly shorter,
    // while the isSmall flag feeds no layout geometry.
    terminalSizeStore.__testReset({ cols: 160, rows: 20, isSmall: true });
    const shortTerminal = readConversationScrollSnapshot();
    expect(shortTerminal.viewportHeight).toBeLessThan(snap.viewportHeight);
    expect(shortTerminal.viewportHeight).toBe(
      getWorkflowViewportHeight({ rows: 20, inputRows: 3, promptRows: 0 }),
    );
  });

  it('reserves no viewport row for the live status, which lives in the footer byline', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const active = readConversationScrollSnapshot();

    lifecycleStore.__testReset({ phase: 'idle' });
    const idle = readConversationScrollSnapshot();

    // The build block is the only chrome a live phase adds; the status byline costs nothing.
    expect(idle.viewportHeight - active.viewportHeight).toBe(
      getProgressRows({ phase: 'implementing', cols: 80 }),
    );
    expect(active.totalHeight).toBe(idle.totalHeight);
  });

  it('measures the transcript around the build progress block', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });

    const progressRows = getProgressRows({ phase: 'implementing', cols: 80 });
    const snap = readConversationScrollSnapshot();

    expect(progressRows).toBe(5);
    // The block rides above the transcript, so its rows leave the body and push its top row down.
    expect(snap.viewportHeight).toBe(
      getWorkflowViewportHeight({ rows: 30, inputRows: 3, progressRows }),
    );
    expect(snap.contentRect.height).toBe(snap.viewportHeight);
    expect(snap.contentRect.top).toBe(getContentTopRow() + progressRows);
  });

  it('gives the block rows back to an open gate, as the screen does', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    approvalPromptStore.__testReset({
      status: 'pending',
      request: makeConfirmRequest('delete generated files'),
      resolve: () => undefined,
    });

    const snap = readConversationScrollSnapshot();

    expect(snap.contentRect.top).toBe(getContentTopRow());
    expect(snap.viewportHeight).toBe(
      getWorkflowViewportHeight({
        rows: 30,
        inputRows: 3,
        promptRows: getApprovalPromptRows(approvalPromptStore.get(), 80),
      }),
    );
  });

  it('cancelled runs paint no block, so the body reclaims its rows', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'running',
      startedAt: 0,
      cancelled: true,
    });

    const snap = readConversationScrollSnapshot();

    expect(snap.contentRect.top).toBe(getContentTopRow());
    expect(snap.viewportHeight).toBe(getWorkflowViewportHeight({ rows: 30, inputRows: 3 }));
  });

  it('gives the block rows back to a parked stop, which has no attempt in flight', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });

    const running = readConversationScrollSnapshot();
    const blockRows = getProgressRows({ phase: 'implementing', cols: 80 });
    expect(blockRows).toBeGreaterThan(0);
    expect(running.contentRect.top).toBe(getContentTopRow() + blockRows);

    stopStore.__testReset({
      intent: 'stop-now',
      phase: 'parked',
      requestedAt: 0,
      parked: { kind: 'mid-brief', taskId: taskId('T001'), resolve: null },
    });

    try {
      const parked = readConversationScrollSnapshot();

      expect(parked.contentRect.top).toBe(getContentTopRow());
      expect(parked.viewportHeight).toBe(running.viewportHeight + blockRows);
    } finally {
      stopStore.__testReset();
    }
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
    const staleHintConversation = readConversationScrollSnapshot();
    const staleHintReview = readReviewContentHeight();
    expect(staleHintConversation.viewportHeight).toBe(withoutPrompt.viewportHeight);
    expect(staleHintReview).toBe(reviewWithoutPrompt);

    controlsStore.setInputMode('question');
    const withPrompt = readConversationScrollSnapshot();
    const reviewWithPrompt = readReviewContentHeight();
    const questionRows = getQuestionPromptRows(hint, 80);

    expect(withPrompt.viewportHeight).toBe(withoutPrompt.viewportHeight - questionRows);
    expect(reviewWithPrompt).toBe(reviewWithoutPrompt - questionRows);
  });

  it('review bottom offset from the snapshot height leaves no hidden lines in the view', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 40, isSmall: true });
    inputHeightStore.__testReset({ rows: 3 });
    const renderedLineCount = 120;
    reviewStore.setRenderedLineCount(renderedLineCount);

    const visibleHeight = readReviewContentHeight();
    const keyboardBottomOffset = Math.max(0, renderedLineCount - visibleHeight);

    const containerHeight = getWorkflowViewportHeight({ rows: 40, inputRows: 3 });
    const viewContentHeight = getReviewContentLayout(
      Math.max(0, containerHeight - REVIEW_FRAME_ROWS),
      renderedLineCount,
    ).contentHeight;

    expect(visibleHeight).toBe(viewContentHeight);
    expect(renderedLineCount - keyboardBottomOffset - viewContentHeight).toBe(0);
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

  it('uses the full content width for scroll calculations', () => {
    eventsStore.__testReset({ events: [makeLongTaskStarted()] });
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    controlsStore.setSidebar(false);

    const snap = readConversationScrollSnapshot();

    // The transcript spends the left gutter as its own lead, so only the right gutter is out.
    expect(snap.contentRect.width).toBe(119);
    expect(snap.conversationWidth).toBe(119);
    expect(snap.contentRect.right).toBe(snap.contentRect.left + 118);
  });

  it('sidebar presence narrows content width', () => {
    terminalSizeStore.__testReset({ cols: 121, rows: 30, isSmall: false });
    controlsStore.setSidebar(false);

    const snapNoSidebar = readConversationScrollSnapshot();

    controlsStore.setSidebar(true);

    const snapWithSidebar = readConversationScrollSnapshot();

    expect(snapWithSidebar.contentRect.width).toBeLessThan(snapNoSidebar.contentRect.width);
  });

  it('shares one body height and bottom row across scroll, hover, and pointer geometry', () => {
    const rows = 30;
    const cols = 121;
    const inputRows = 3;
    terminalSizeStore.__testReset({ cols, rows, isSmall: false });
    inputHeightStore.__testReset({ rows: inputRows });
    controlsStore.setSidebar(true);
    reviewStore.setRenderedLineCount(0);

    const fullBodyHeight = getWorkflowViewportHeight({ rows, inputRows });
    const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible: true });
    const scroll = readConversationScrollSnapshot();
    const hover = readConversationHoverSnapshot();
    const pointerVisibleCount = hover.stickyLeadingRows + hover.viewportHeight;

    expect(sidebarWidth).toBeGreaterThan(0);
    expect(scroll.contentRect.height).toBe(fullBodyHeight);
    expect(scroll.transcriptViewportHeight).toBe(fullBodyHeight);
    expect(hover.viewportHeight).toBe(scroll.transcriptViewportHeight);
    expect(hover.contentRect.bottom).toBe(scroll.contentRect.bottom);
    expect(
      hitTranscriptRow({
        rect: hover.contentRect,
        sgrX: hover.contentRect.left,
        sgrY: hover.contentRect.bottom,
        visibleCount: pointerVisibleCount,
      }),
    ).toBe(pointerVisibleCount - 1);
    expect(
      hitTranscriptRow({
        rect: hover.contentRect,
        sgrX: hover.contentRect.left,
        sgrY: scroll.contentRect.bottom + 1,
        visibleCount: pointerVisibleCount,
      }),
    ).toBeNull();

    expect(readReviewContentHeight()).toBe(
      getReviewContentLayout(Math.max(0, fullBodyHeight - REVIEW_FRAME_ROWS), 0).contentHeight,
    );
  });

  it('keeps hidden-sidebar scroll, hover, and pointer geometry at the full body height', () => {
    const rows = 30;
    const cols = 120;
    const inputRows = 3;
    terminalSizeStore.__testReset({ cols, rows, isSmall: false });
    inputHeightStore.__testReset({ rows: inputRows });
    controlsStore.setSidebar(false);

    const fullBodyHeight = getWorkflowViewportHeight({ rows, inputRows });
    const scroll = readConversationScrollSnapshot();
    const hover = readConversationHoverSnapshot();
    const pointerVisibleCount = hover.stickyLeadingRows + hover.viewportHeight;

    expect(scroll.contentRect.height).toBe(fullBodyHeight);
    expect(scroll.transcriptViewportHeight).toBe(fullBodyHeight);
    expect(hover.viewportHeight).toBe(fullBodyHeight);
    expect(hover.contentRect.bottom).toBe(scroll.contentRect.bottom);
    expect(
      hitTranscriptRow({
        rect: hover.contentRect,
        sgrX: hover.contentRect.left,
        sgrY: hover.contentRect.bottom,
        visibleCount: pointerVisibleCount,
      }),
    ).toBe(pointerVisibleCount - 1);
    expect(
      hitTranscriptRow({
        rect: hover.contentRect,
        sgrX: hover.contentRect.left,
        sgrY: hover.contentRect.bottom + 1,
        visibleCount: pointerVisibleCount,
      }),
    ).toBeNull();
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

  it('maps saved quick researching to the Plan Form-C zone under a standard config', () => {
    terminalSizeStore.__testReset({ cols: 30, rows: 30, isSmall: true });
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'standard' } }) });
    lifecycleStore.__testReset({ phase: 'researching', status: 'running', startedAt: 0 });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ mode: 'quick' }),
      execution: { kind: 'at-rest' },
    });

    try {
      // The run's saved quick mode beats the standard config: an old quick `researching` phase has
      // no Spec step to activate, so Plan is the active stage and Form C's only zone.
      const quick = readRailSnapshot();
      expect(quick.activeIndex).toBe(1);
      expect(quick.zones).toHaveLength(1);
      expect(quick.zones[0]?.stage).toBe('plan');
      expect(quick.zones[0]?.index).toBe(1);

      // Standard control: the same researching phase under standard mode activates Spec.
      routerStore.init({
        screen: 'workflow',
        run: makeRunRecord({ mode: 'standard' }),
        execution: { kind: 'at-rest' },
      });
      const standard = readRailSnapshot();
      expect(standard.activeIndex).toBe(0);
      expect(standard.zones).toHaveLength(1);
      expect(standard.zones[0]?.stage).toBe('spec');
      expect(standard.zones[0]?.index).toBe(0);
    } finally {
      routerStore.reset();
      configStore.__testReset();
    }
  });

  it('keeps a fresh run on its resolved mode when the next-run config changes', () => {
    terminalSizeStore.__testReset({ cols: 30, rows: 30, isSmall: true });
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'standard' } }) });
    lifecycleStore.__testReset({ phase: 'researching', status: 'running', startedAt: 0 });
    // A fresh run: home read the record before any state was saved, so it carries no mode.
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ mode: null }),
      execution: { kind: 'at-rest' },
    });
    // The engine resolved the mode this run started under; quick has no Spec step.
    modeAdviceStore.__testReset({ mode: 'quick' });

    try {
      const before = readRailSnapshot();
      expect(before.activeIndex).toBe(1);
      expect(before.zones[0]?.stage).toBe('plan');

      // `/mode speckit` is written for the next run and must not move this run's rail.
      configStore.__testReset({ config: makeConfig({ workflow: { mode: 'speckit' } }) });
      const after = readRailSnapshot();
      expect(after).toEqual(before);
    } finally {
      routerStore.reset();
      configStore.__testReset();
      modeAdviceStore.__testReset();
    }
  });

  it('keeps a fresh run on its prepared mode when the next-run config changes', () => {
    terminalSizeStore.__testReset({ cols: 30, rows: 30, isSmall: true });
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'standard' } }) });
    lifecycleStore.__testReset({ phase: 'researching', status: 'running', startedAt: 0 });
    // A fresh local run whose record was read before any state was saved: no recorded and no
    // resolved mode yet, but its prepared execution still knows the config it started under.
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ mode: null }),
      execution: {
        kind: 'local',
        prepared: makePreparedExecution({
          projectDir: '/tmp/prepared-run',
          sessionId: 'prepared-run-session',
          feature: 'add auth',
          config: makeConfig({ workflow: { mode: 'quick' } }),
        }),
      },
    });
    modeAdviceStore.__testReset();

    try {
      const before = readRailSnapshot();
      expect(before.activeIndex).toBe(1);
      expect(before.zones[0]?.stage).toBe('plan');

      // `/mode speckit` is written for the next run and must not move this run's rail or zones.
      configStore.__testReset({ config: makeConfig({ workflow: { mode: 'speckit' } }) });
      const after = readRailSnapshot();
      expect(after).toEqual(before);
    } finally {
      routerStore.reset();
      configStore.__testReset();
      modeAdviceStore.__testReset();
    }
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
    // Form B paints no inline fraction, so dropping it (cancelled) cannot shift the trailing
    // zones — the geometry mirrors rail.tsx.
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

  it('budgets no block for a run at rest, which the screen paints without one', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    routerStore.init({ screen: 'workflow', run: makeRunRecord(), execution: { kind: 'at-rest' } });

    try {
      expect(readConversationScrollSnapshot().contentRect.height).toBe(
        getWorkflowViewportHeight({ rows: 30, inputRows: 3, progressRows: 0 }),
      );
    } finally {
      routerStore.reset();
    }
  });

  it('keeps the review body on the same rows as the transcript while the block paints', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'final-review', status: 'running', startedAt: 0 });
    reviewStore.setRenderedLineCount(0);

    const progressRows = getProgressRows({ phase: 'final-review', cols: 80 });
    const bodyHeight = getWorkflowViewportHeight({ rows: 40, inputRows: 3, progressRows });

    expect(progressRows).toBe(5);
    // Both panes are handed the screen's one content height, so the review frame is measured
    // around the block exactly as the transcript is.
    expect(readConversationScrollSnapshot().contentRect.height).toBe(bodyHeight);
    expect(readReviewContentHeight()).toBe(
      getReviewContentLayout(Math.max(0, bodyHeight - REVIEW_FRAME_ROWS), 0).contentHeight,
    );
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
  it('gives brief review the same body height as the conversation when the sidebar is visible', () => {
    const rows = 30;
    const inputRows = 3;
    const cols = 121;
    terminalSizeStore.__testReset({ cols, rows, isSmall: false });
    inputHeightStore.__testReset({ rows: inputRows });
    controlsStore.setSidebar(true);
    lifecycleStore.__testReset({ phase: 'reviewing-briefs', status: 'running', startedAt: 0 });
    reviewStore.setRenderedLineCount(1);

    const snap = readBriefListSnapshot();
    if (!snap) throw new Error('expected a brief list snapshot while reviewing briefs');

    const fullBodyHeight = getWorkflowViewportHeight({ rows, inputRows });
    const conversation = readConversationScrollSnapshot().contentRect;

    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: true })).toBeGreaterThan(0);
    expect(snap.rect.height).toBe(fullBodyHeight);
    expect(snap.rect.height).toBe(conversation.height);
    expect(snap.rect.bottom).toBe(conversation.bottom);
    expect(snap.rect.bottom).toBe(snap.rect.top + fullBodyHeight - 1);
  });

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
    controlsStore.setSidebar(false);

    const snap = readBriefListSnapshot();
    if (!snap) throw new Error('expected a brief list snapshot while reviewing briefs');

    // The review column is uncapped, so the brief card fills the content pane past the gutter its
    // frame stands in.
    const fullContentWidth = getWorkflowContentWidth({
      cols: 300,
      sidebarVisible: false,
    });
    expect(fullContentWidth).toBeGreaterThan(120);
    expect(snap.rect.left).toBe(WORKFLOW_GUTTER_X);
    expect(snap.rect.width).toBe(fullContentWidth - WORKFLOW_GUTTER_X);
    expect(snap.rect.right).toBe(snap.rect.left + snap.rect.width - 1);

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

it('remeasures the active structured question after advancing and going back', () => {
  terminalSizeStore.__testReset({ cols: 80, rows: 40, isSmall: true });
  inputHeightStore.__testReset({ rows: 3 });
  const withoutPrompt = readConversationScrollSnapshot().viewportHeight;
  questionPromptStore.setHint('Type your answer…');
  questionPromptStore.setQuestions([
    { id: 'first', type: 'input', text: 'Short question?' },
    {
      id: 'second',
      type: 'choice',
      text: 'A longer question with choices?',
      options: ['First choice', 'Second choice', 'Third choice'],
    },
  ]);
  controlsStore.setInputMode('question');
  const firstHeight = readConversationScrollSnapshot().viewportHeight;
  questionPromptStore.answer('answer');
  const current = questionPromptStore.get();
  const secondHeight = readConversationScrollSnapshot().viewportHeight;
  expect(secondHeight).toBe(
    withoutPrompt - getQuestionPromptRows('Type your answer…', 80, current.questions, 1),
  );
  expect(secondHeight).toBeLessThan(firstHeight);
  questionPromptStore.previous();
  expect(readConversationScrollSnapshot().viewportHeight).toBe(firstHeight);
});

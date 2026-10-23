import { plainUserMessage } from '../../../core/types/user-input.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import {
  readConversationHoverSnapshot,
  readConversationScrollSnapshot,
  readRailSnapshot,
  readReviewContentHeight,
} from './snapshot.js';
import { getRailStageZones, hitTranscriptRow } from './hit-test.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { makeReviewFixInsertedEvents, makeTaskStart } from '#testing/helpers/events/task.js';
import { getContentTopRow, getProgressRows } from './chrome-rows.js';
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
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  REVIEW_FRAME_ROWS,
} from './rect.js';
import { taskId } from '../../../core/schemas/task.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { transcriptTailStore } from '../../../stores/workflow/transcript-tail.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { ConversationFlow } from '../components/conversation-flow/flow.js';
import type { ConversationRowBlock } from '../conversation-rows/types.js';
import { row } from '../conversation-rows/row-format/rows.js';
import { handleWorkflowMouseWheel } from '../hooks/use-mouse-scroll.js';
import { findVisualScenario } from '#testing/visual/catalog.js';
import { scenarioId } from '#testing/visual/contracts/identifiers.js';
import { viewport } from '#testing/visual/contracts/geometry.js';
import { mountGalleryScenario } from '#testing/visual/gallery/mount.js';
import { resultMenuHeight } from '../result/options.js';
import { WorkflowScreen } from '../../../app/screens/workflow.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../stores/project/config.js';

beforeEach(() => {
  terminalSizeStore.reset();
  inputHeightStore.reset();
  conversationScrollStore.reset();
  resetWorkflow();
  controlsStore.reset();
  reviewStore.reset();
  approvalPromptStore.reset();
  questionPromptStore.reset();
  overlayStore.reset();
  transcriptTailStore.__testReset();
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
  it('scrolls retained ready-to-apply transcript rows in the painted 60x18 viewport', async () => {
    const scenario = findVisualScenario(scenarioId('workflow-review-task-cadence-settled'));
    if (scenario === undefined) throw new Error('Missing settled cadence scenario');
    const checkpoint = scenario.checkpoints[0];
    if (checkpoint === undefined) throw new Error('Missing settled cadence checkpoint');
    const ui = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: viewport({ cols: 60, rows: 18 }),
    });
    try {
      const bottomFrame = await ui.waitForCheckpoint();
      const snapshot = readConversationScrollSnapshot();
      const paintedHeight = getWorkflowViewportHeight({
        rows: 18,
        inputRows: inputHeightStore.get().rows,
        promptRows: resultMenuHeight(
          { override: false, findings: [], confirming: false, files: null },
          60,
        ),
      });
      expect(snapshot.totalHeight).toBe(29);
      expect(snapshot.viewportHeight).toBe(paintedHeight);
      expect(snapshot.transcriptViewportHeight).toBe(paintedHeight);
      expect(snapshot.maxOffset).toBeGreaterThan(0);
      expect(stripAnsiStyles(bottomFrame)).toContain('Final review after 1 fix cycle passed');
      conversationScrollStore.scrollUp({ ...snapshot, step: snapshot.maxOffset });
      const topFrame = await ui.waitForCheckpoint({
        predicate: ({ output }) => stripAnsiStyles(output).includes('T001 Add validator module'),
      });
      expect(readConversationScrollSnapshot().scrollOffset).toBe(snapshot.maxOffset);
      expect(stripAnsiStyles(topFrame)).toContain('T001 Add validator module');
      expect(stripAnsiStyles(topFrame)).not.toContain('Final review after 1 fix cycle passed');
      conversationScrollStore.scrollToBottom(snapshot.renderableCount);
      expect(stripAnsiStyles(await ui.waitForCheckpoint())).toContain(
        'Final review after 1 fix cycle passed',
      );
    } finally {
      await ui.unmount();
    }
  });

  it('scrolls an open run to its first rows while the draft warning sits at its tail', async () => {
    const scenario = findVisualScenario(scenarioId('workflow-draft-not-saved'));
    if (scenario === undefined) throw new Error('Missing draft-not-saved scenario');
    const checkpoint = scenario.checkpoints[0];
    if (checkpoint === undefined) throw new Error('Missing draft-not-saved checkpoint');
    const ui = await mountGalleryScenario({
      scenario,
      checkpoint,
      viewport: viewport({ cols: 80, rows: 24 }),
    });
    try {
      await ui.waitForCheckpoint();
      addEvent({
        type: 'planner_text',
        ts: 1_700_000_000_000,
        phase: 'implementing',
        text: 'A reply long enough to push the first rows of the run out of the pane.\n'
          .repeat(8)
          .trimEnd(),
      });
      const bottomFrame = stripAnsiStyles(
        await ui.waitForCheckpoint({
          predicate: ({ output }) => stripAnsiStyles(output).includes('lines above'),
        }),
      );
      expect(bottomFrame).toContain('Pending 1');
      expect(bottomFrame).toContain('Warning');
      const snapshot = readConversationScrollSnapshot();
      expect(snapshot.maxOffset).toBeGreaterThan(0);
      conversationScrollStore.scrollUp({ ...snapshot, step: snapshot.maxOffset });
      const topFrame = stripAnsiStyles(
        await ui.waitForCheckpoint({
          predicate: ({ output }) => !stripAnsiStyles(output).includes('lines above'),
        }),
      );
      expect(readConversationScrollSnapshot().scrollOffset).toBe(snapshot.maxOffset);
      expect(topFrame).toContain('Pending 1');
    } finally {
      await ui.unmount();
    }
  });

  it("a ready run's result menu reduces the snapshot transcript rows the same as the screen", async () => {
    const findings = ['Missing receiving test', 'Missing stock check', 'Missing error check'];
    configStore.__testReset({ config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
    routerStore.init({
      screen: 'workflow',
      execution: { kind: 'at-rest' },
      run: makeRunRecord({
        status: { kind: 'ready-to-apply', override: true },
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({
            phase: 'complete',
            acceptedAsIs: { at: '2026-10-10T00:00:00.000Z', findings },
          }),
        },
      }),
    });
    eventsStore.__testReset({
      events: [
        {
          type: 'planner_text',
          ts: 1,
          phase: 'planning',
          text: 'Retained row.\n'.repeat(40).trimEnd(),
        },
      ],
    });
    const ui = renderFeature(
      createElement(WorkflowScreen, { commands: [], onRuntimeCommand: () => undefined }),
      { cols: 80, rows: 24 },
    );
    try {
      await flushEffects();
      for (const confirming of [false, true]) {
        if (confirming) {
          ui.stdin.write('\r');
          await flushEffects();
        }
        const frame = stripAnsiStyles(ui.lastFrame() ?? '');
        expect(frame).toContain(
          confirming ? 'Apply with 3 open findings?' : 'Ready to apply as is',
        );
        const expectedRows = getWorkflowViewportHeight({
          rows: 24,
          inputRows: inputHeightStore.get().rows,
          promptRows: resultMenuHeight({ override: true, findings, confirming, files: null }, 80),
        });
        const snapshot = readConversationScrollSnapshot();
        expect(snapshot.transcriptViewportHeight).toBe(expectedRows);
        expect(snapshot.maxOffset).toBe(snapshot.totalHeight - expectedRows);
        expect(frame.split('\n').filter((line) => line.includes('Retained row.'))).toHaveLength(
          expectedRows,
        );
      }
    } finally {
      ui.unmount();
      routerStore.reset();
      configStore.reset();
    }
    await flushEffects();
    expect(readConversationScrollSnapshot().transcriptViewportHeight).toBe(
      getWorkflowViewportHeight({ rows: 24, inputRows: inputHeightStore.get().rows }),
    );
  });

  it.each([
    { label: 'recovery reset the running brief to pending', closed: false },
    { label: 'closed run below the sidebar breakpoint', closed: true },
  ])('keeps rendered scroll ends and mouse rows aligned after $label', async ({ closed }) => {
    const cols = 80;
    const rows = 24;
    terminalSizeStore.__testReset({ cols, rows, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    controlsStore.setSidebar(true);
    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: true })).toBe(0);
    if (closed) {
      routerStore.init({
        screen: 'workflow',
        execution: { kind: 'at-rest' },
        run: makeRunRecord({ status: { kind: 'closed', as: 'complete' } }),
      });
    }
    lifecycleStore.__testReset({ phase: closed ? 'complete' : 'implementing' });
    tasksStore.__testReset({
      currentTask: 1,
      totalTasks: 1,
      tasks: [{ id: 'T001', title: 'Reset brief', status: 'pending' }],
    });
    eventsStore.__testReset({
      events: Array.from({ length: 50 }, (_, ts) => ({
        type: 'planner_text',
        ts,
        phase: 'planning',
        text: `event-${ts}`,
      })),
    });
    const tail: ConversationRowBlock[] = closed
      ? [
          {
            key: 'closed',
            rowCount: 8,
            renderableUnits: 0,
            createRows: (start, end) =>
              Array.from({ length: end - start }, (_, offset) =>
                row({ key: `closed-${start + offset}`, text: `closed-row-${start + offset}` }),
              ),
          },
        ]
      : [];
    const height = getWorkflowViewportHeight({
      rows,
      inputRows: 3,
      progressRows: getProgressRows({ phase: closed ? 'complete' : 'implementing', cols }),
    });
    let above = '';
    const ui = renderFeature(
      createElement(ConversationFlow, {
        height,
        conversationWidth: cols - 1,
        contentWidth: cols - 1,
        tail,
        onScrollAbove: (label) => {
          above = label;
        },
      }),
      { cols, rows },
    );
    try {
      await flushEffects();
      const bottom = readConversationScrollSnapshot();
      expect(bottom.transcriptViewportHeight).toBe(height);
      expect(bottom.viewportHeight).toBe(height);
      expect(bottom.maxOffset).toBe(bottom.totalHeight - height);
      expect(bottom.scrollOffset).toBe(0);
      expect(stripAnsiStyles(ui.lastFrame())).not.toContain('Pending');
      expect(stripAnsiStyles(ui.lastFrame())).toContain(closed ? 'closed-row-7' : 'event-49');
      expect(above).toBe(`${bottom.maxOffset} lines above`);

      conversationScrollStore.__testReset({ scrollOffset: bottom.maxOffset });
      await flushEffects();
      expect(readConversationScrollSnapshot().scrollOffset).toBe(bottom.maxOffset);
      expect(above).toBe('');
      expect(stripAnsiStyles(ui.lastFrame())).toContain('event-0');
      handleWorkflowMouseWheel({
        type: 'wheel-down',
        x: 1,
        y: 4,
        button: 0,
        shift: false,
        meta: false,
        ctrl: false,
      });
      await flushEffects();
      expect(readConversationScrollSnapshot().scrollOffset).toBe(bottom.maxOffset - 1);
      expect(above).toBe('1 line above');

      const hover = readConversationHoverSnapshot();
      expect(hover.viewportHeight).toBe(height);
      expect(
        hitTranscriptRow({
          rect: hover.contentRect,
          sgrX: hover.contentRect.left,
          sgrY: hover.contentRect.bottom,
          visibleCount: hover.viewportHeight,
        }),
      ).toBe(height - 1);
    } finally {
      ui.unmount();
      routerStore.reset();
      await flushEffects();
    }
  });

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

    expect(progressRows).toBe(3);
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
      parked: { kind: 'mid-brief', taskId: taskId('T001'), resolve: null, kept: [] },
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
    const pointerVisibleCount = hover.viewportHeight;

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
    const pointerVisibleCount = hover.viewportHeight;

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
  it.each([true, false])(
    'matches the compact hit zone with build block shown %s',
    (buildBlockShown) => {
      terminalSizeStore.__testReset({ cols: 20, rows: 24, isSmall: true });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
      for (const event of makeReviewFixInsertedEvents()) addEvent(event);
      tasksStore.__testReset({ ...tasksStore.get(), currentTask: 100 });
      if (!buildBlockShown) overlayStore.open('stop-sheet');

      expect(readRailSnapshot().zones).toEqual(
        getRailStageZones({
          form: 'C',
          phase: 'implementing',
          cols: 20,
          fraction: buildBlockShown ? '' : '4/7',
          cancelled: false,
        }),
      );
    },
  );

  it('returns clickable zones for the active streaming rail', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });

    const snap = readRailSnapshot();

    expect(snap.activeIndex).toBe(1);
    expect(snap.zones.length).toBeGreaterThan(0);
    expect(snap.zones.some((zone) => zone.index === 1)).toBe(true);
  });

  it('exposes only the active-stage zone in Form C at a narrow width', () => {
    terminalSizeStore.__testReset({ cols: 20, rows: 30, isSmall: true });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    // 18 content cells cannot fit the three-stage marker+connector line, so the rail drops to Form C.
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });

    const snap = readRailSnapshot();

    expect(snap.zones).toHaveLength(1);
    expect(snap.zones.every((zone) => zone.index === 1)).toBe(true);
  });

  it('maps an old researching phase to the Plan Form-C zone', () => {
    terminalSizeStore.__testReset({ cols: 20, rows: 30, isSmall: true });
    lifecycleStore.__testReset({ phase: 'researching', status: 'running', startedAt: 0 });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord(),
      execution: { kind: 'at-rest' },
    });
    try {
      const snap = readRailSnapshot();
      expect(snap.activeIndex).toBe(0);
      expect(snap.zones).toHaveLength(1);
      expect(snap.zones[0]?.stage).toBe('plan');
      expect(snap.zones[0]?.index).toBe(0);
    } finally {
      routerStore.reset();
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

    expect(live.zones).toHaveLength(3);
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

    // The review block states no attempt and no estimate, so it is three rows at this width.
    expect(progressRows).toBe(3);
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
  questionPromptStore.answer(plainUserMessage('answer'));
  const current = questionPromptStore.get();
  const secondHeight = readConversationScrollSnapshot().viewportHeight;
  expect(secondHeight).toBe(
    withoutPrompt - getQuestionPromptRows('Type your answer…', 80, current.questions, 1),
  );
  expect(secondHeight).toBeLessThan(firstHeight);
  questionPromptStore.previous();
  expect(readConversationScrollSnapshot().viewportHeight).toBe(firstHeight);
});

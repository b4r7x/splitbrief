import { beforeEach, describe, expect, it } from 'vitest';
import { readConversationScrollSnapshot, readReviewContentHeight } from './snapshot.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../stores/cost-approval/prompt.js';
import { getApprovalPromptRows } from '../prompt-rows.js';
import { getWorkflowViewportHeight } from './rect.js';
import { taskId } from '../../../core/schemas/task.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import type { EngineEvent } from '../../../engine/events/types.js';

beforeEach(() => {
  terminalSizeStore.reset();
  inputHeightStore.reset();
  conversationScrollStore.reset();
  resetWorkflow();
  controlsStore.reset();
  reviewStore.reset();
  approvalPromptStore.reset();
  costApprovalStore.reset();
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
  return {
    type: 'task_started',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'No-op workflow demonstration with enough metadata to wrap',
    index: 0,
    total: 1,
    file: 'README.md',
    action: 'modify',
    tool: 'claude-code',
    model: 'sonnet',
    implementerProfile: 'default',
    contextFit: 'fits',
    estimatedTokens: 3911,
    contextLength: 32768,
    currentCodeContextMode: 'whole-file',
    costPosture: 'Selected unknown cost tier via cheapest-capable routing',
  };
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
    const fullBodyHeight = getWorkflowViewportHeight(40, 3, false, 0, 160);

    expect(snap.contentRect.width).toBe(158);
    expect(snap.conversationWidth).toBe(158);
    expect(snap.conversationRect.width).toBe(158);
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

  it('accounts for config chrome rows when a workflow-config event is present', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    const snapWithout = readConversationScrollSnapshot();

    eventsStore.__testReset({
      events: [
        {
          type: 'workflow_config',
          ts: 0,
          phase: 'idle' as const,
          mode: 'standard',
          plannerTool: 'claude-code',
          implementerTool: 'ollama',
        },
      ],
    });

    const snapWith = readConversationScrollSnapshot();

    expect(snapWith.viewportHeight).toBeLessThan(snapWithout.viewportHeight);
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

    expect(snap.contentRect.width).toBe(118);
    expect(snap.conversationWidth).toBe(118);
    expect(snap.conversationRect.width).toBe(118);
    expect(snap.conversationRect.right).toBe(snap.conversationRect.left + 117);
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

    expect(tallContent).toBe(shortContent - 1);
  });
});

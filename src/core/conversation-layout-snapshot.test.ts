import { beforeEach, describe, expect, it } from 'vitest';
import { readConversationScrollSnapshot, readReviewContentHeight } from './conversation-layout-snapshot.js';
import { terminalSizeStore } from '../stores/terminal-size.js';
import { inputHeightStore } from '../stores/input-height.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { workflowStore } from '../stores/workflow.js';
import { reviewStore } from '../stores/review.js';

beforeEach(() => {
  terminalSizeStore.reset();
  inputHeightStore.reset();
  conversationScrollStore.reset();
  workflowStore.reset();
  reviewStore.reset();
});

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
    terminalSizeStore.reset({ cols: 160, rows: 40, isSmall: false });
    inputHeightStore.reset({ rows: 3 });

    const snap = readConversationScrollSnapshot();

    expect(snap.contentRect.width).toBe(160); // no sidebar, no config → full width
    expect(snap.viewportHeight).toBeGreaterThan(0);
    expect(snap.viewportHeight).toBeLessThan(40);
  });

  it('reduces viewportHeight on a small terminal', () => {
    terminalSizeStore.reset({ cols: 80, rows: 20, isSmall: true });
    inputHeightStore.reset({ rows: 3 });

    const snap = readConversationScrollSnapshot();

    expect(snap.viewportHeight).toBeGreaterThanOrEqual(0);
    expect(snap.viewportHeight).toBeLessThan(20);
  });

  it('accounts for config chrome rows when a workflow-config event is present', () => {
    terminalSizeStore.reset({ cols: 120, rows: 30, isSmall: false });
    inputHeightStore.reset({ rows: 3 });

    const snapWithout = readConversationScrollSnapshot();

    workflowStore.reset({
      ...workflowStore.get(),
      events: [{ type: 'workflow-config', ts: 0, mode: 'standard', plannerTool: 'claude-code', implementerTool: 'ollama' }],
    });

    const snapWith = readConversationScrollSnapshot();

    expect(snapWith.viewportHeight).toBeLessThan(snapWithout.viewportHeight);
  });

  it('sidebar presence narrows content width', () => {
    terminalSizeStore.reset({ cols: 120, rows: 30, isSmall: false });

    const snapNoSidebar = readConversationScrollSnapshot();

    workflowStore.reset({ ...workflowStore.get(), sidebarVisible: true });

    const snapWithSidebar = readConversationScrollSnapshot();

    expect(snapWithSidebar.contentRect.width).toBeLessThan(snapNoSidebar.contentRect.width);
  });

  it('scrollOffset stays within [0, maxOffset]', () => {
    terminalSizeStore.reset({ cols: 120, rows: 30, isSmall: false });
    conversationScrollStore.reset({ ...conversationScrollStore.get(), scrollOffset: 999 });

    const snap = readConversationScrollSnapshot();

    expect(snap.scrollOffset).toBeGreaterThanOrEqual(0);
    expect(snap.scrollOffset).toBeLessThanOrEqual(snap.maxOffset);
  });
});

describe('readReviewContentHeight', () => {
  it('returns a positive height for a normal terminal with content', () => {
    terminalSizeStore.reset({ cols: 120, rows: 30, isSmall: false });
    inputHeightStore.reset({ rows: 3 });
    reviewStore.setLineCount(50);

    const height = readReviewContentHeight();

    expect(height).toBeGreaterThan(0);
  });

  it('accounts for scrollable content by reserving a footer row', () => {
    terminalSizeStore.reset({ cols: 120, rows: 30, isSmall: false });
    inputHeightStore.reset({ rows: 3 });

    reviewStore.setLineCount(1);
    const shortContent = readReviewContentHeight();

    reviewStore.setLineCount(1000);
    const tallContent = readReviewContentHeight();

    expect(tallContent).toBeLessThanOrEqual(shortContent);
  });
});

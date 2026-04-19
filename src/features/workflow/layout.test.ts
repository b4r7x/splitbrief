import { beforeEach, describe, expect, it } from 'vitest';
import { readConversationScrollSnapshot, readReviewContentHeight } from './layout.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { resetWorkflow } from '../../stores/workflow/actions.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { reviewStore } from '../../stores/workflow/review.js';

beforeEach(() => {
  terminalSizeStore.reset();
  inputHeightStore.reset();
  conversationScrollStore.reset();
  resetWorkflow();
  controlsStore.reset();
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
    terminalSizeStore.__testReset({ cols: 160, rows: 40, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    const snap = readConversationScrollSnapshot();

    expect(snap.contentRect.width).toBe(160); // no sidebar, no config → full width
    expect(snap.viewportHeight).toBeGreaterThan(0);
    expect(snap.viewportHeight).toBeLessThan(40);
  });

  it('reduces viewportHeight on a small terminal', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: true });
    inputHeightStore.__testReset({ rows: 3 });

    const snap = readConversationScrollSnapshot();

    expect(snap.viewportHeight).toBeGreaterThanOrEqual(0);
    expect(snap.viewportHeight).toBeLessThan(20);
  });

  it('accounts for config chrome rows when a workflow-config event is present', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    const snapWithout = readConversationScrollSnapshot();

    eventsStore.__testReset({
      events: [{ type: 'workflow-config', ts: 0, mode: 'standard', plannerTool: 'claude-code', implementerTool: 'ollama' }],
    });

    const snapWith = readConversationScrollSnapshot();

    expect(snapWith.viewportHeight).toBeLessThan(snapWithout.viewportHeight);
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
    reviewStore.setLineCount(50);

    const height = readReviewContentHeight();

    expect(height).toBeGreaterThan(0);
  });

  it('accounts for scrollable content by reserving a footer row', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });

    reviewStore.setLineCount(1);
    const shortContent = readReviewContentHeight();

    reviewStore.setLineCount(1000);
    const tallContent = readReviewContentHeight();

    expect(tallContent).toBeLessThanOrEqual(shortContent);
  });
});

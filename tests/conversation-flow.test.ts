import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateEventHeight, getVisibleWindow } from '../src/ui/conversation-flow.js';
import type { TuiEvent } from '../src/types.js';

function makeEvent(type: TuiEvent['type'], extra?: Record<string, unknown>): TuiEvent {
  return { type, ts: Date.now(), ...extra } as TuiEvent;
}

describe('estimateEventHeight', () => {
  it('returns 3 for planner-status', () => {
    assert.equal(estimateEventHeight(makeEvent('planner-status', { phase: 'researching', status: 'running' })), 3);
  });

  it('returns 3 for planner-text', () => {
    assert.equal(estimateEventHeight(makeEvent('planner-text', { text: 'hi' })), 3);
  });

  it('returns 4 for task-start', () => {
    assert.equal(estimateEventHeight(makeEvent('task-start', { taskId: 't1', title: 'T', index: 0, total: 1, file: 'a.ts', action: 'create' })), 4);
  });

  it('returns 4 for implementer-generate without expanded diff', () => {
    assert.equal(estimateEventHeight(makeEvent('implementer-generate', { status: 'done' })), 4);
  });

  it('returns 6 for implementer-generate with expanded diff', () => {
    assert.equal(estimateEventHeight(makeEvent('implementer-generate', { status: 'done' }), true), 6);
  });

  it('returns 4 for validate pass', () => {
    assert.equal(estimateEventHeight(makeEvent('validate', { status: 'done', passed: true, stages: { tsc: true, lint: true, test: true } })), 4);
  });

  it('returns 5 for validate with error', () => {
    assert.equal(estimateEventHeight(makeEvent('validate', { status: 'done', passed: false, stages: { tsc: false, lint: true, test: true }, error: 'tsc failed' })), 5);
  });

  it('returns 3 for retry', () => {
    assert.equal(estimateEventHeight(makeEvent('retry', { taskId: 't1', attempt: 1, maxRetries: 3 })), 3);
  });

  it('returns 3 for escalate without hint', () => {
    assert.equal(estimateEventHeight(makeEvent('escalate', { tier: 1 })), 3);
  });

  it('returns 4 for escalate with hint', () => {
    assert.equal(estimateEventHeight(makeEvent('escalate', { tier: 1, hint: 'try this' })), 4);
  });

  it('returns 3 for git-commit', () => {
    assert.equal(estimateEventHeight(makeEvent('git-commit', { message: 'fix: stuff' })), 3);
  });

  it('returns 3 for error', () => {
    assert.equal(estimateEventHeight(makeEvent('error', { message: 'boom' })), 3);
  });

  it('returns 3 for task-complete', () => {
    assert.equal(estimateEventHeight(makeEvent('task-complete', { taskId: 't1', title: 'T', method: 'local', retries: 0, duration: 1000 })), 3);
  });

  it('returns 3 for task-skipped', () => {
    assert.equal(estimateEventHeight(makeEvent('task-skipped', { taskId: 't1', title: 'T', reason: 'dep failed' })), 3);
  });
});

describe('getVisibleWindow', () => {
  it('returns empty range for empty events', () => {
    const result = getVisibleWindow([], 10, 0);
    assert.deepEqual(result, { start: 0, end: 0 });
  });

  it('returns full range when events fit within height', () => {
    const events: TuiEvent[] = [
      makeEvent('planner-text', { text: 'a' }),
      makeEvent('planner-text', { text: 'b' }),
      makeEvent('planner-text', { text: 'c' }),
    ];
    // 3 events at 3 lines each = 9 total
    const result = getVisibleWindow(events, 10, 0);
    assert.deepEqual(result, { start: 0, end: 3 });
  });

  it('shows only visible window when events exceed height', () => {
    // 10 events, each 3 lines, height=9 fits 3
    const events: TuiEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const result = getVisibleWindow(events, 9, 0);
    assert.equal(result.end, 10);
    assert.equal(result.end - result.start, 3);
  });

  it('scrolling up shifts the window backward', () => {
    const events: TuiEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const atTail = getVisibleWindow(events, 9, 0);
    const scrolledUp = getVisibleWindow(events, 9, 2);
    assert(scrolledUp.end < atTail.end);
    assert.equal(scrolledUp.end - scrolledUp.start, 3);
  });

  it('scrolling back to offset 0 follows the tail', () => {
    const events: TuiEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const result = getVisibleWindow(events, 9, 0);
    assert.equal(result.end, 10);
  });

  it('accounts for expanded diffs in height calculation', () => {
    const events: TuiEvent[] = [
      makeEvent('planner-text', { text: 'a' }),
      makeEvent('implementer-generate', { status: 'done' }),
      makeEvent('planner-text', { text: 'b' }),
      makeEvent('planner-text', { text: 'c' }),
    ];
    // Without expansion: 3+4+3+3=13, height=13 => all fit
    const noExpand = getVisibleWindow(events, 13, 0);
    assert.deepEqual(noExpand, { start: 0, end: 4 });

    // With expansion: 3+6+3+3=15, height=13 => not all fit
    const expanded = new Set([1]);
    const withExpand = getVisibleWindow(events, 13, 0, expanded);
    assert(withExpand.end - withExpand.start < 4);
  });

  it('clamps scroll offset to valid range', () => {
    const events: TuiEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    // Scroll offset way beyond events length
    const result = getVisibleWindow(events, 9, 100);
    assert(result.start >= 0);
    assert(result.end >= result.start);
  });

  it('scroll down (decrement offset) moves window forward toward tail', () => {
    const events: TuiEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const scrolledUp = getVisibleWindow(events, 9, 4);
    const scrolledDown = getVisibleWindow(events, 9, 2);
    assert(scrolledDown.end > scrolledUp.end, 'scrolling down should move end closer to tail');
  });

  it('auto-follow: new events at offset 0 always shows latest', () => {
    const events5: TuiEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const events8: TuiEvent[] = Array.from({ length: 8 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const before = getVisibleWindow(events5, 9, 0);
    const after = getVisibleWindow(events8, 9, 0);
    assert.equal(before.end, 5);
    assert.equal(after.end, 8);
  });
});

describe('ConversationFlow component', () => {
  it('exports a default forwardRef component', async () => {
    const mod = await import('../src/ui/conversation-flow.js');
    assert.ok(mod.default, 'should export default');
    // forwardRef components have $$typeof and render
    assert.equal(typeof (mod.default as { render?: unknown }).render, 'function');
  });

  it('exports estimateEventHeight and getVisibleWindow', async () => {
    const mod = await import('../src/ui/conversation-flow.js');
    assert.equal(typeof mod.estimateEventHeight, 'function');
    assert.equal(typeof mod.getVisibleWindow, 'function');
  });

  it('getVisibleWindow slices correct events for EventCard rendering', () => {
    const events: TuiEvent[] = [
      makeEvent('planner-status', { phase: 'researching', status: 'running' }),
      makeEvent('task-start', { taskId: 'T001', title: 'Add auth', index: 0, total: 1, file: 'src/auth.ts', action: 'create' }),
      makeEvent('implementer-generate', { status: 'done', model: 'x', file: 'f.ts', duration: 100 }),
      makeEvent('validate', { status: 'done', passed: true, stages: { tsc: true, lint: true, test: true } }),
      makeEvent('git-commit', { message: 'feat: auth' }),
    ];
    // height=18 fits all (3+4+4+4+3=18)
    const { start, end } = getVisibleWindow(events, 18, 0);
    const visible = events.slice(start, end);
    assert.equal(visible.length, 5, 'all events should be visible');
  });

  it('windowed slice maps expandedDiffs indices correctly', () => {
    const events: TuiEvent[] = Array.from({ length: 20 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const expandedDiffs = new Set([18, 19]);
    const { start, end } = getVisibleWindow(events, 9, 0, expandedDiffs);
    // Verify the slice contains the tail events
    assert.equal(end, 20, 'should end at the last event');
    assert.ok(start >= 15, 'start should be near the end');
    // Verify expandedDiffs lookup uses global indices
    assert.ok(expandedDiffs.has(start + (end - start - 2)), 'second-to-last in window matches expandedDiffs');
  });
});

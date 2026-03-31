import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateEventHeight, getVisibleWindow } from '../src/ui/conversation-flow.js';
import type { TuiEvent } from '../src/types.js';

function makeEvent(type: TuiEvent['type'], extra?: Record<string, unknown>): TuiEvent {
  return { type, ts: Date.now(), ...extra } as TuiEvent;
}

describe('estimateEventHeight', () => {
  it('returns 1 for planner-status', () => {
    assert.equal(estimateEventHeight(makeEvent('planner-status', { phase: 'researching', status: 'running' })), 1);
  });

  it('returns 1 for planner-text', () => {
    assert.equal(estimateEventHeight(makeEvent('planner-text', { text: 'hi' })), 1);
  });

  it('returns 1 for task-start', () => {
    assert.equal(estimateEventHeight(makeEvent('task-start', { taskId: 't1', title: 'T', index: 0, total: 1, file: 'a.ts', action: 'create' })), 1);
  });

  it('returns 2 for implementer-generate without expanded diff', () => {
    assert.equal(estimateEventHeight(makeEvent('implementer-generate', { status: 'done' })), 2);
  });

  it('returns 4 for implementer-generate with expanded diff', () => {
    assert.equal(estimateEventHeight(makeEvent('implementer-generate', { status: 'done' }), true), 4);
  });

  it('returns 1 for validate pass', () => {
    assert.equal(estimateEventHeight(makeEvent('validate', { passed: true, stages: { tsc: true, lint: true, test: true } })), 1);
  });

  it('returns 2 for validate with error', () => {
    assert.equal(estimateEventHeight(makeEvent('validate', { passed: false, stages: { tsc: false, lint: true, test: true }, error: 'tsc failed' })), 2);
  });

  it('returns 1 for retry', () => {
    assert.equal(estimateEventHeight(makeEvent('retry', { taskId: 't1', attempt: 1, maxRetries: 3 })), 1);
  });

  it('returns 1 for escalate without hint', () => {
    assert.equal(estimateEventHeight(makeEvent('escalate', { tier: 1 })), 1);
  });

  it('returns 2 for escalate with hint', () => {
    assert.equal(estimateEventHeight(makeEvent('escalate', { tier: 1, hint: 'try this' })), 2);
  });

  it('returns 1 for git-commit', () => {
    assert.equal(estimateEventHeight(makeEvent('git-commit', { message: 'fix: stuff' })), 1);
  });

  it('returns 1 for error', () => {
    assert.equal(estimateEventHeight(makeEvent('error', { message: 'boom' })), 1);
  });

  it('returns 1 for task-complete', () => {
    assert.equal(estimateEventHeight(makeEvent('task-complete', { taskId: 't1', title: 'T', method: 'local', retries: 0, duration: 1000 })), 1);
  });

  it('returns 1 for task-skipped', () => {
    assert.equal(estimateEventHeight(makeEvent('task-skipped', { taskId: 't1', title: 'T', reason: 'dep failed' })), 1);
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
    const result = getVisibleWindow(events, 10, 0);
    assert.deepEqual(result, { start: 0, end: 3 });
  });

  it('shows only visible window when events exceed height', () => {
    // 10 events, each 1 line, height=3
    const events: TuiEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const result = getVisibleWindow(events, 3, 0);
    assert.equal(result.end, 10);
    assert.equal(result.end - result.start, 3);
  });

  it('scrolling up shifts the window backward', () => {
    const events: TuiEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const atTail = getVisibleWindow(events, 3, 0);
    const scrolledUp = getVisibleWindow(events, 3, 2);
    assert(scrolledUp.end < atTail.end);
    assert.equal(scrolledUp.end - scrolledUp.start, 3);
  });

  it('scrolling back to offset 0 follows the tail', () => {
    const events: TuiEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const result = getVisibleWindow(events, 3, 0);
    assert.equal(result.end, 10);
  });

  it('accounts for expanded diffs in height calculation', () => {
    const events: TuiEvent[] = [
      makeEvent('planner-text', { text: 'a' }),
      makeEvent('implementer-generate', { status: 'done' }),
      makeEvent('planner-text', { text: 'b' }),
      makeEvent('planner-text', { text: 'c' }),
    ];
    // Without expansion: 1+2+1+1=5, height=5 => all fit
    const noExpand = getVisibleWindow(events, 5, 0);
    assert.deepEqual(noExpand, { start: 0, end: 4 });

    // With expansion: 1+4+1+1=7, height=5 => not all fit
    const expanded = new Set([1]);
    const withExpand = getVisibleWindow(events, 5, 0, expanded);
    assert(withExpand.end - withExpand.start < 4);
  });

  it('clamps scroll offset to valid range', () => {
    const events: TuiEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    // Scroll offset way beyond events length
    const result = getVisibleWindow(events, 3, 100);
    assert(result.start >= 0);
    assert(result.end >= result.start);
  });

  it('scroll down (decrement offset) moves window forward toward tail', () => {
    const events: TuiEvent[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const scrolledUp = getVisibleWindow(events, 3, 4);
    const scrolledDown = getVisibleWindow(events, 3, 2);
    assert(scrolledDown.end > scrolledUp.end, 'scrolling down should move end closer to tail');
  });

  it('auto-follow: new events at offset 0 always shows latest', () => {
    const events5: TuiEvent[] = Array.from({ length: 5 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const events8: TuiEvent[] = Array.from({ length: 8 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const before = getVisibleWindow(events5, 3, 0);
    const after = getVisibleWindow(events8, 3, 0);
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
      makeEvent('validate', { passed: true, stages: { tsc: true, lint: true, test: true } }),
      makeEvent('git-commit', { message: 'feat: auth' }),
    ];
    // height=10 fits all (1+1+2+1+1=6)
    const { start, end } = getVisibleWindow(events, 10, 0);
    const visible = events.slice(start, end);
    assert.equal(visible.length, 5, 'all events should be visible');
  });

  it('windowed slice maps expandedDiffs indices correctly', () => {
    const events: TuiEvent[] = Array.from({ length: 20 }, (_, i) =>
      makeEvent('planner-text', { text: `line ${i}` }),
    );
    const expandedDiffs = new Set([18, 19]);
    const { start, end } = getVisibleWindow(events, 5, 0, expandedDiffs);
    // Verify the slice contains the tail events
    assert.equal(end, 20, 'should end at the last event');
    assert.ok(start >= 15, 'start should be near the end');
    // Verify expandedDiffs lookup uses global indices
    assert.ok(expandedDiffs.has(start + (end - start - 2)), 'second-to-last in window matches expandedDiffs');
  });
});

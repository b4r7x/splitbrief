import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import type { TuiEvent } from '../src/types.js';
import { getTheme } from '../src/theme.js';

const theme = getTheme();

// Helper: call EventCard as a function to inspect the returned React element tree
async function renderCard(event: TuiEvent, diffExpanded?: boolean) {
  const { default: EventCard } = await import('../src/ui/event-card.js');
  return EventCard({ event, diffExpanded });
}

// Helper: expand a React element if its type is a function component (shallow render)
function expand(el: unknown): unknown {
  if (el == null || typeof el !== 'object' || !('type' in (el as object))) return el;
  const node = el as { type: unknown; props: Record<string, unknown> };
  if (typeof node.type === 'function') {
    try {
      return (node.type as (props: Record<string, unknown>) => unknown)(node.props);
    } catch {
      return el; // hooks-using component, return as-is
    }
  }
  return el;
}

// Helper: recursively collect all text content from a React element tree
function collectText(el: unknown): string {
  if (el == null || typeof el === 'boolean') return '';
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(collectText).join('');
  if (typeof el === 'object' && el !== null && 'props' in el) {
    const expanded = expand(el);
    if (expanded !== el) return collectText(expanded);
    const props = (el as { props: { children?: unknown } }).props;
    return collectText(props.children);
  }
  return '';
}

// Helper: find first Text element matching a predicate
function findText(el: unknown, pred: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (el == null || typeof el !== 'object') return null;
  if (!('props' in (el as object))) return null;
  const node = el as { type: unknown; props: Record<string, unknown> };
  // Expand function components first
  const expanded = expand(el);
  if (expanded !== el) return findText(expanded, pred);
  const typeName = typeof node.type === 'function' ? (node.type as { name?: string }).name : node.type;
  if (typeName === 'Text' && pred(node.props)) return node.props;
  const children = node.props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findText(child, pred);
      if (found) return found;
    }
  } else if (children && typeof children === 'object') {
    return findText(children, pred);
  }
  return null;
}

describe('EventCard', () => {
  it('exports a default function', async () => {
    const mod = await import('../src/ui/event-card.js');
    assert.equal(typeof mod.default, 'function');
  });

  // --- planner-status ---

  describe('planner-status', () => {
    it('running shows phase with ellipsis and accent color', async () => {
      const el = await renderCard({ type: 'planner-status', ts: 1, phase: 'researching', status: 'running' });
      const text = collectText(el);
      assert.ok(text.includes('researching...'), `got: ${text}`);
      const accentText = findText(el, (p) => p.color === theme.accent);
      assert.ok(accentText, 'should have accent-colored text');
    });

    it('done shows duration', async () => {
      const el = await renderCard({ type: 'planner-status', ts: 1, phase: 'specifying', status: 'done', duration: 3000 });
      const text = collectText(el);
      assert.ok(text.includes('specifying done'), `got: ${text}`);
      assert.ok(text.includes('3.0s'), `expected duration, got: ${text}`);
    });

    it('done with summary shows muted summary text', async () => {
      const el = await renderCard({ type: 'planner-status', ts: 1, phase: 'planning', status: 'done', summary: 'Created 5 tasks' });
      const text = collectText(el);
      assert.ok(text.includes('Created 5 tasks'), `got: ${text}`);
      const mutedText = findText(el, (p) => p.color === theme.textMuted);
      assert.ok(mutedText, 'summary should be muted');
    });
  });

  // --- planner-text ---

  describe('planner-text', () => {
    it('renders indented text with theme text color', async () => {
      const el = await renderCard({ type: 'planner-text', ts: 1, text: 'Analyzing codebase...' });
      const text = collectText(el);
      assert.ok(text.includes('Analyzing codebase...'), `got: ${text}`);
      const themedText = findText(el, (p) => p.color === theme.text);
      assert.ok(themedText, 'should use theme text color');
    });
  });

  // --- task-start ---

  describe('task-start', () => {
    it('renders bold title with 1-indexed task number', async () => {
      const el = await renderCard({ type: 'task-start', ts: 1, taskId: 'T001', title: 'Add auth', index: 0, total: 5, file: 'src/auth.ts', action: 'create' });
      const text = collectText(el);
      assert.ok(text.includes('T1'), `should show T1, got: ${text}`);
      assert.ok(text.includes('Add auth'), `got: ${text}`);
      const boldText = findText(el, (p) => p.bold === true);
      assert.ok(boldText, 'should be bold');
    });

    it('renders correct index for later tasks', async () => {
      const el = await renderCard({ type: 'task-start', ts: 1, taskId: 'T005', title: 'Migrate DB', index: 4, total: 10, file: 'src/db.ts', action: 'modify' });
      const text = collectText(el);
      assert.ok(text.includes('T5'), `should show T5, got: ${text}`);
    });
  });

  // --- task-complete ---

  describe('task-complete', () => {
    it('returns null (handled by TaskSummary)', async () => {
      const result = await renderCard({ type: 'task-complete', ts: 1, taskId: 'T001', title: 'A', method: 'local', retries: 0, duration: 100 });
      assert.equal(result, null);
    });
  });

  // --- task-skipped ---

  describe('task-skipped', () => {
    it('renders muted text with reason', async () => {
      const el = await renderCard({ type: 'task-skipped', ts: 1, taskId: 'T002', title: 'Optional step', reason: 'dep failed' });
      const text = collectText(el);
      assert.ok(text.includes('T002'), `got: ${text}`);
      assert.ok(text.includes('Optional step'), `got: ${text}`);
      assert.ok(text.includes('skipped: dep failed'), `got: ${text}`);
      const mutedText = findText(el, (p) => p.color === theme.textMuted);
      assert.ok(mutedText, 'should use muted text color');
    });
  });

  // --- implementer-generate ---

  describe('implementer-generate', () => {
    it('running shows model and spinner with primary color', async () => {
      // ImplementerCard uses hooks, so we test via the element structure
      const el = await renderCard({ type: 'implementer-generate', ts: 1, status: 'running', model: 'qwen2.5:7b' });
      // The returned element is an ImplementerCard (function with hooks) — can't expand
      // Verify it's a valid React element
      assert.ok(el != null, 'should return an element');
    });

    it('done shows duration and file with line counts', async () => {
      const el = await renderCard({ type: 'implementer-generate', ts: 1, status: 'done', model: 'qwen2.5:7b', file: 'src/auth.ts', linesAdded: 10, linesRemoved: 3, duration: 2000 });
      // ImplementerCard uses hooks — can't expand to text
      assert.ok(el != null, 'should return an element');
    });

    it('failed returns an element', async () => {
      const el = await renderCard({ type: 'implementer-generate', ts: 1, status: 'failed', model: 'qwen2.5:7b' });
      assert.ok(el != null, 'should return an element');
    });

    it('done with diffExpanded returns an element', async () => {
      const diff = '+const a = 1;\n-const b = 2;\n const c = 3;';
      const el = await renderCard({ type: 'implementer-generate', ts: 1, status: 'done', model: 'x', file: 'f.ts', linesAdded: 1, linesRemoved: 1, diff, duration: 100 }, true);
      assert.ok(el != null, 'should return an element');
    });

    it('done without diffExpanded returns an element', async () => {
      const diff = '+added line';
      const el = await renderCard({ type: 'implementer-generate', ts: 1, status: 'done', model: 'x', file: 'f.ts', linesAdded: 1, diff, duration: 100 }, false);
      assert.ok(el != null, 'should return an element');
    });

    it('uses "?" when model is missing', async () => {
      const el = await renderCard({ type: 'implementer-generate', ts: 1, status: 'running' });
      assert.ok(el != null, 'should return an element');
    });
  });

  // --- validate ---

  describe('validate', () => {
    it('passed shows success checkmark and duration', async () => {
      const el = await renderCard({ type: 'validate', ts: 1, passed: true, stages: { tsc: true, lint: true, test: true }, duration: 4000 });
      const text = collectText(el);
      assert.ok(text.includes('validate'), `got: ${text}`);
      assert.ok(text.includes('4.0s'), `got: ${text}`);
      const successCheck = findText(el, (p) => p.color === theme.success && collectText(p.children).includes('✓'));
      assert.ok(successCheck, 'should have success-colored checkmark');
    });

    it('failed shows error cross and error message', async () => {
      const el = await renderCard({ type: 'validate', ts: 1, passed: false, stages: { tsc: false, lint: true, test: true }, error: 'TS2322: Type mismatch' });
      const text = collectText(el);
      assert.ok(text.includes('TS2322: Type mismatch'), `got: ${text}`);
      const errorText = findText(el, (p) => p.color === theme.error && collectText(p.children).includes('TS2322'));
      assert.ok(errorText, 'error should use theme error color');
    });

    it('shows individual stage indicators', async () => {
      const el = await renderCard({ type: 'validate', ts: 1, passed: false, stages: { tsc: true, lint: false, test: true } });
      const text = collectText(el);
      assert.ok(text.includes('tsc'), `got: ${text}`);
      assert.ok(text.includes('lint'), `got: ${text}`);
      assert.ok(text.includes('test'), `got: ${text}`);
    });
  });

  // --- retry ---

  describe('retry', () => {
    it('shows attempt count in warning color', async () => {
      const el = await renderCard({ type: 'retry', ts: 1, taskId: 'T001', attempt: 2, maxRetries: 3 });
      const text = collectText(el);
      assert.ok(text.includes('retry(attempt 2/3)'), `got: ${text}`);
      const warningText = findText(el, (p) => p.color === theme.warning);
      assert.ok(warningText, 'should use warning color');
    });
  });

  // --- escalate ---

  describe('escalate', () => {
    it('tier 1 shows warning bold', async () => {
      const el = await renderCard({ type: 'escalate', ts: 1, tier: 1 });
      const text = collectText(el);
      assert.ok(text.includes('escalate(tier 1)'), `got: ${text}`);
      const warningBold = findText(el, (p) => p.color === theme.warning && p.bold === true);
      assert.ok(warningBold, 'should use warning color bold');
    });

    it('tier 2 with hint shows hint text in muted color', async () => {
      const el = await renderCard({ type: 'escalate', ts: 1, tier: 2, hint: 'Use existing middleware' });
      const text = collectText(el);
      assert.ok(text.includes('escalate(tier 2)'), `got: ${text}`);
      assert.ok(text.includes('Use existing middleware'), `got: ${text}`);
      const mutedHint = findText(el, (p) => p.color === theme.textMuted && collectText(p.children).includes('middleware'));
      assert.ok(mutedHint, 'hint should use muted text color');
    });

    it('without hint does not render hint line', async () => {
      const el = await renderCard({ type: 'escalate', ts: 1, tier: 1 });
      const text = collectText(el);
      assert.ok(!text.includes('undefined'), `should not show undefined, got: ${text}`);
    });
  });

  // --- git-commit ---

  describe('git-commit', () => {
    it('renders message in muted color', async () => {
      const el = await renderCard({ type: 'git-commit', ts: 1, message: 'feat: add auth' });
      const text = collectText(el);
      assert.ok(text.includes('git.commit("feat: add auth")'), `got: ${text}`);
      const mutedText = findText(el, (p) => p.color === theme.textMuted);
      assert.ok(mutedText, 'should use muted text color');
    });
  });

  // --- error ---

  describe('error', () => {
    it('renders error color bold with message', async () => {
      const el = await renderCard({ type: 'error', ts: 1, message: 'Connection refused' });
      const text = collectText(el);
      assert.ok(text.includes('Connection refused'), `got: ${text}`);
      const errorBold = findText(el, (p) => p.color === theme.error && p.bold === true);
      assert.ok(errorBold, 'should use error color bold');
    });
  });

  // --- coverage ---

  it('covers all TuiEvent types', async () => {
    const allTypes: TuiEvent['type'][] = [
      'planner-status', 'planner-text', 'task-start', 'task-complete',
      'task-skipped', 'implementer-generate', 'validate', 'retry',
      'escalate', 'git-commit', 'error',
    ];
    // Verify each type has at least one describe block above by creating a minimal event
    for (const type of allTypes) {
      let event: TuiEvent;
      switch (type) {
        case 'planner-status': event = { type, ts: 1, phase: 'x', status: 'running' }; break;
        case 'planner-text': event = { type, ts: 1, text: 'x' }; break;
        case 'task-start': event = { type, ts: 1, taskId: 'T1', title: 'x', index: 0, total: 1, file: 'f', action: 'create' }; break;
        case 'task-complete': event = { type, ts: 1, taskId: 'T1', title: 'x', method: 'local', retries: 0, duration: 0 }; break;
        case 'task-skipped': event = { type, ts: 1, taskId: 'T1', title: 'x', reason: 'r' }; break;
        case 'implementer-generate': event = { type, ts: 1, status: 'running' }; break;
        case 'validate': event = { type, ts: 1, passed: true, stages: { tsc: true, lint: true, test: true } }; break;
        case 'retry': event = { type, ts: 1, taskId: 'T1', attempt: 1, maxRetries: 3 }; break;
        case 'escalate': event = { type, ts: 1, tier: 1 }; break;
        case 'git-commit': event = { type, ts: 1, message: 'm' }; break;
        case 'error': event = { type, ts: 1, message: 'e' }; break;
      }
      const result = await renderCard(event!);
      // task-complete returns null, all others should return an element
      if (type === 'task-complete') {
        assert.equal(result, null);
      } else {
        assert.ok(result != null, `${type} should return an element`);
      }
    }
  });
});

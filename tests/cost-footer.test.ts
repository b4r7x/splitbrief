import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { formatCost } from '../src/utils/format.js';
import { rateColor } from '../src/ui/cost-footer.js';
import { getTheme } from '../src/theme.js';

const theme = getTheme();

// Helper: recursively collect all text from a React element tree
function collectText(el: unknown): string {
  if (el == null || typeof el === 'boolean') return '';
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(collectText).join('');
  if (typeof el === 'object' && el !== null && 'props' in el) {
    const props = (el as { props: { children?: unknown } }).props;
    return collectText(props.children);
  }
  return '';
}

// Helper: find a Text element by predicate in a React tree
function findText(el: unknown, pred: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (el == null || typeof el !== 'object') return null;
  if (!('props' in (el as object))) return null;
  const node = el as { type: unknown; props: Record<string, unknown> };
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

describe('CostFooter', () => {
  it('exports a default function component', async () => {
    const mod = await import('../src/ui/cost-footer.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('renders all fields (task progress, local rate, cost, savings, model)', async () => {
    const { default: CostFooter } = await import('../src/ui/cost-footer.js');
    const tree = CostFooter({
      currentTask: 4,
      totalTasks: 8,
      localRate: 75,
      estimatedCost: 0.02,
      estimatedSavings: 1.40,
      implementerModel: 'qwen2.5-coder:7b',
    });

    const text = collectText(tree);
    assert.ok(text.includes('Task 4/8'), 'should show task progress');
    assert.ok(text.includes('Local: 75%'), 'should show local rate');
    assert.ok(text.includes('$0.02'), 'should show estimated cost');
    assert.ok(text.includes('Saved: ~$1.40'), 'should show savings');
    assert.ok(text.includes('qwen2.5-coder:7b'), 'should show model name');
  });

  it('local rate color: high (>=50%) = theme.success', () => {
    assert.equal(rateColor(50), theme.success);
    assert.equal(rateColor(75), theme.success);
    assert.equal(rateColor(100), theme.success);
  });

  it('local rate color: medium (25-49%) = theme.warning', () => {
    assert.equal(rateColor(25), theme.warning);
    assert.equal(rateColor(49), theme.warning);
  });

  it('local rate color: low (<25%) = theme.error', () => {
    assert.equal(rateColor(0), theme.error);
    assert.equal(rateColor(24), theme.error);
  });

  it('applies correct color to local rate text in rendered output', async () => {
    const { default: CostFooter } = await import('../src/ui/cost-footer.js');

    const highTree = CostFooter({ currentTask: 1, totalTasks: 1, localRate: 80, estimatedCost: 0, estimatedSavings: 0, implementerModel: 'm' });
    const highRateText = findText(highTree, (p) => p.color === theme.success && collectText(p.children).includes('Local:'));
    assert.ok(highRateText, 'high rate should use success color');

    const lowTree = CostFooter({ currentTask: 1, totalTasks: 1, localRate: 10, estimatedCost: 0, estimatedSavings: 0, implementerModel: 'm' });
    const lowRateText = findText(lowTree, (p) => p.color === theme.error && collectText(p.children).includes('Local:'));
    assert.ok(lowRateText, 'low rate should use error color');
  });

  it('savings text uses success color', async () => {
    const { default: CostFooter } = await import('../src/ui/cost-footer.js');
    const tree = CostFooter({ currentTask: 1, totalTasks: 1, localRate: 50, estimatedCost: 0.01, estimatedSavings: 0.99, implementerModel: 'm' });
    const savingsText = findText(tree, (p) => p.color === theme.success && collectText(p.children).includes('Saved:'));
    assert.ok(savingsText, 'savings should use success color');
  });

  it('formats costs using formatCost', () => {
    assert.equal(formatCost(0.02), '$0.02');
    assert.equal(formatCost(1.40), '$1.40');
    assert.equal(formatCost(0), '$0.00');
  });

  it('zero tasks (0/0) edge case', async () => {
    const { default: CostFooter } = await import('../src/ui/cost-footer.js');
    const tree = CostFooter({
      currentTask: 0,
      totalTasks: 0,
      localRate: 0,
      estimatedCost: 0,
      estimatedSavings: 0,
      implementerModel: 'none',
    });

    const text = collectText(tree);
    assert.ok(text.includes('Task 0/0'), 'should show 0/0');
    assert.ok(text.includes('Local: 0%'), 'should show 0%');
    assert.ok(text.includes('$0.00'), 'should show $0.00');
  });
});

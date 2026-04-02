import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { formatCost } from '../src/utils/format.js';
import { rateColor, renderCostFooter } from '../src/ui/cost-footer.js';
import { getTheme } from '../src/theme.js';
import { collectText, findText } from './helpers/react-tree.js';

const theme = getTheme();

describe('CostFooter', () => {
  it('exports a default function component', async () => {
    const mod = await import('../src/ui/cost-footer.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('renders all fields (task progress, local rate, cost, savings, model)', () => {
    const tree = renderCostFooter({
      currentTask: 4,
      totalTasks: 8,
      localRate: 75,
      estimatedCost: 0.02,
      estimatedSavings: 1.40,
      implementerModel: 'qwen2.5-coder:7b',
    }, theme);

    const text = collectText(tree);
    assert.ok(text.includes('Task 4/8'), 'should show task progress');
    assert.ok(text.includes('Local: 75%'), 'should show local rate');
    assert.ok(text.includes('$0.02'), 'should show estimated cost');
    assert.ok(text.includes('Saved: ~$1.40'), 'should show savings');
    assert.ok(text.includes('qwen2.5-coder:7b'), 'should show model name');
  });

  it('local rate color: high (>=50%) = theme.success', () => {
    assert.equal(rateColor(50, theme), theme.success);
    assert.equal(rateColor(75, theme), theme.success);
    assert.equal(rateColor(100, theme), theme.success);
  });

  it('local rate color: medium (25-49%) = theme.warning', () => {
    assert.equal(rateColor(25, theme), theme.warning);
    assert.equal(rateColor(49, theme), theme.warning);
  });

  it('local rate color: low (<25%) = theme.error', () => {
    assert.equal(rateColor(0, theme), theme.error);
    assert.equal(rateColor(24, theme), theme.error);
  });

  it('applies correct color to local rate text in rendered output', () => {
    const highTree = renderCostFooter({ currentTask: 1, totalTasks: 1, localRate: 80, estimatedCost: 0, estimatedSavings: 0, implementerModel: 'm' }, theme);
    const highRateText = findText(highTree, (p) => p.color === theme.success && collectText(p.children).includes('Local:'));
    assert.ok(highRateText, 'high rate should use success color');

    const lowTree = renderCostFooter({ currentTask: 1, totalTasks: 1, localRate: 10, estimatedCost: 0, estimatedSavings: 0, implementerModel: 'm' }, theme);
    const lowRateText = findText(lowTree, (p) => p.color === theme.error && collectText(p.children).includes('Local:'));
    assert.ok(lowRateText, 'low rate should use error color');
  });

  it('savings text uses success color', () => {
    const tree = renderCostFooter({ currentTask: 1, totalTasks: 1, localRate: 50, estimatedCost: 0.01, estimatedSavings: 0.99, implementerModel: 'm' }, theme);
    const savingsText = findText(tree, (p) => p.color === theme.success && collectText(p.children).includes('Saved:'));
    assert.ok(savingsText, 'savings should use success color');
  });

  it('formats costs using formatCost', () => {
    assert.equal(formatCost(0.02), '$0.02');
    assert.equal(formatCost(1.40), '$1.40');
    assert.equal(formatCost(0), '$0.00');
  });

  it('zero tasks (0/0) edge case', () => {
    const tree = renderCostFooter({
      currentTask: 0,
      totalTasks: 0,
      localRate: 0,
      estimatedCost: 0,
      estimatedSavings: 0,
      implementerModel: 'none',
    }, theme);

    const text = collectText(tree);
    assert.ok(text.includes('Task 0/0'), 'should show 0/0');
    assert.ok(text.includes('Local: 0%'), 'should show 0%');
    assert.ok(text.includes('$0.00'), 'should show $0.00');
  });
});

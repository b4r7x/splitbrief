import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { formatCost } from '../src/utils/format.js';
import { rateColor } from '../src/tui/cost-footer.js';

describe('CostFooter', () => {
  it('exports a default function component', async () => {
    const mod = await import('../src/tui/cost-footer.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('renders all fields (task progress, local rate, cost, savings, model)', async () => {
    const { default: CostFooter } = await import('../src/tui/cost-footer.js');
    const tree = CostFooter({
      currentTask: 4,
      totalTasks: 8,
      localRate: 75,
      estimatedCost: 0.02,
      estimatedSavings: 1.40,
      implementerModel: 'qwen2.5-coder:7b',
    });

    const children = tree.props.children;
    const texts = children.map((c: React.ReactElement) => c.props.children);
    const flat = texts.flat().join('');
    assert.ok(flat.includes('Task 4/8'), 'should show task progress');
    assert.ok(flat.includes('Local: 75%'), 'should show local rate');
    assert.ok(flat.includes('$0.02'), 'should show estimated cost');
    assert.ok(flat.includes('Saved: ~$1.40'), 'should show savings');
    assert.ok(flat.includes('qwen2.5-coder:7b'), 'should show model name');
  });

  it('local rate color: high (>=50%) = cyan', () => {
    assert.equal(rateColor(50), 'cyan');
    assert.equal(rateColor(75), 'cyan');
    assert.equal(rateColor(100), 'cyan');
  });

  it('local rate color: medium (25-49%) = yellow', () => {
    assert.equal(rateColor(25), 'yellow');
    assert.equal(rateColor(49), 'yellow');
  });

  it('local rate color: low (<25%) = red', () => {
    assert.equal(rateColor(0), 'red');
    assert.equal(rateColor(24), 'red');
  });

  it('applies correct color to local rate text in rendered output', async () => {
    const { default: CostFooter } = await import('../src/tui/cost-footer.js');

    const highTree = CostFooter({ currentTask: 1, totalTasks: 1, localRate: 80, estimatedCost: 0, estimatedSavings: 0, implementerModel: 'm' });
    const rateText = highTree.props.children[1];
    assert.equal(rateText.props.color, 'cyan');

    const lowTree = CostFooter({ currentTask: 1, totalTasks: 1, localRate: 10, estimatedCost: 0, estimatedSavings: 0, implementerModel: 'm' });
    const lowRateText = lowTree.props.children[1];
    assert.equal(lowRateText.props.color, 'red');
  });

  it('savings text is green', async () => {
    const { default: CostFooter } = await import('../src/tui/cost-footer.js');
    const tree = CostFooter({ currentTask: 1, totalTasks: 1, localRate: 50, estimatedCost: 0.01, estimatedSavings: 0.99, implementerModel: 'm' });
    const savingsText = tree.props.children[3];
    assert.equal(savingsText.props.color, 'green');
  });

  it('formats costs using formatCost', () => {
    assert.equal(formatCost(0.02), '$0.02');
    assert.equal(formatCost(1.40), '$1.40');
    assert.equal(formatCost(0), '$0.00');
  });

  it('zero tasks (0/0) edge case', async () => {
    const { default: CostFooter } = await import('../src/tui/cost-footer.js');
    const tree = CostFooter({
      currentTask: 0,
      totalTasks: 0,
      localRate: 0,
      estimatedCost: 0,
      estimatedSavings: 0,
      implementerModel: 'none',
    });

    const children = tree.props.children;
    const flat = children.map((c: React.ReactElement) => c.props.children).flat().join('');
    assert.ok(flat.includes('Task 0/0'), 'should show 0/0');
    assert.ok(flat.includes('Local: 0%'), 'should show 0%');
    assert.ok(flat.includes('$0.00'), 'should show $0.00');
  });
});

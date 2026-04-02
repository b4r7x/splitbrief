import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import type { ReactElement } from 'react';

// Helper: call DialogCard as a function to inspect the returned React element tree
async function renderCard(props: { label?: string; color?: string; children: ReactElement }): Promise<unknown> {
  const { default: DialogCard } = await import('../src/tui/dialog-card.js');
  return DialogCard(props);
}

// Helper: recursively collect all text content from a React element tree
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

// Helper: find first Text element matching a predicate
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

describe('DialogCard', () => {
  it('exports a default function', async () => {
    const mod = await import('../src/tui/dialog-card.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('renders children', async () => {
    const { Text } = await import('ink');
    const el = await renderCard({ children: <Text>test content</Text> });
    const text = collectText(el);
    assert.ok(text.includes('test content'), `got: ${text}`);
  });

  it('renders label in border', async () => {
    const { Text } = await import('ink');
    const el = await renderCard({ label: 'PLAN', children: <Text>test</Text> });
    const text = collectText(el);
    assert.ok(text.includes('[PLAN]'), `should include [PLAN], got: ${text}`);
    assert.ok(text.includes('┌'), `should include border start, got: ${text}`);
    assert.ok(text.includes('└'), `should include border end, got: ${text}`);
  });

  it('renders clean border without label', async () => {
    const { Text } = await import('ink');
    const el = await renderCard({ children: <Text>test</Text> });
    const text = collectText(el);
    assert.ok(!text.includes('['), `should not include bracket, got: ${text}`);
    assert.ok(text.includes('┌'), `should include border start, got: ${text}`);
    assert.ok(text.includes('└'), `should include border end, got: ${text}`);
  });

  it('applies color prop', async () => {
    const { Text } = await import('ink');
    const el = await renderCard({ color: 'cyan', children: <Text>test</Text> });
    const cyanText = findText(el, (p) => p.color === 'cyan');
    assert.ok(cyanText, 'should have cyan colored border');
  });

  it('defaults to white color', async () => {
    const { Text } = await import('ink');
    const el = await renderCard({ children: <Text>test</Text> });
    const text = collectText(el);
    assert.ok(text.includes('┌'), `should render, got: ${text}`);
  });
});

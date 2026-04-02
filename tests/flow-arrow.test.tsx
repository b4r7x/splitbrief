import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Helper: call FlowArrow as a function to inspect the returned React element tree
async function renderArrow(props: { direction: 'down' | 'up'; label?: string }): Promise<unknown> {
  const { default: FlowArrow } = await import('../src/tui/flow-arrow.js');
  return FlowArrow(props);
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

describe('FlowArrow', () => {
  it('exports a default function', async () => {
    const mod = await import('../src/tui/flow-arrow.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('renders ▼ when direction="down"', async () => {
    const el = await renderArrow({ direction: 'down' });
    const text = collectText(el);
    assert.ok(text.includes('▼'), `should include ▼, got: ${text}`);
  });

  it('renders ▲ when direction="up"', async () => {
    const el = await renderArrow({ direction: 'up' });
    const text = collectText(el);
    assert.ok(text.includes('▲'), `should include ▲, got: ${text}`);
  });

  it('renders label when provided', async () => {
    const el = await renderArrow({ direction: 'down', label: 'task >> implementer' });
    const text = collectText(el);
    assert.ok(text.includes('▼'), `should include arrow, got: ${text}`);
    assert.ok(text.includes('task >> implementer'), `should include label, got: ${text}`);
  });

  it('renders without label', async () => {
    const el = await renderArrow({ direction: 'down' });
    const text = collectText(el);
    assert.ok(text.includes('▼'), `should include arrow, got: ${text}`);
  });
});

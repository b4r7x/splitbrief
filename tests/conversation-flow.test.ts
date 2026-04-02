import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('ConversationFlow component', () => {
  it('exports a default forwardRef component', async () => {
    const mod = await import('../src/ui/conversation-flow.js');
    assert.ok(mod.default, 'should export default');
    // forwardRef components have $$typeof and render
    assert.equal(typeof (mod.default as { render?: unknown }).render, 'function');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('SlashInput', () => {
  it('exports a default function', async () => {
    const mod = await import('../src/tui/slash-input.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('imports required dependencies', async () => {
    const mod = await import('../src/tui/slash-input.js');
    assert.ok(mod.default, 'should export default component');
  });
});

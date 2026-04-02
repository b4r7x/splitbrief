import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('ModePicker', () => {
  it('exports a default function', async () => {
    const mod = await import('../src/tui/mode-picker.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('imports required dependencies', async () => {
    const mod = await import('../src/tui/mode-picker.js');
    assert.ok(mod.default, 'should export default component');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('HelpOverlay', () => {
  it('exports a default function', async () => {
    const mod = await import('../src/tui/help-overlay.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('imports required dependencies', async () => {
    const mod = await import('../src/tui/help-overlay.js');
    assert.ok(mod.default, 'should export default component');
  });
});

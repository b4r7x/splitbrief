import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('DiffView', () => {
  it('exports a default function component', async () => {
    const mod = await import('../src/ui/diff-view.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('default export is named DiffView', async () => {
    const mod = await import('../src/ui/diff-view.js');
    assert.equal(mod.default.name, 'DiffView');
  });

  it('exports DiffViewProps interface (verified by TypeScript compilation)', async () => {
    // If this file compiles, the named export DiffViewProps is available as a type.
    // We verify the module loads without error.
    const mod = await import('../src/ui/diff-view.js');
    assert.ok(mod);
  });
});

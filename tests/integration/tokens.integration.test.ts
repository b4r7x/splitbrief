import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardIntegration, type TestGuard } from './guard.js';
import { createInitialState, saveState, loadState } from '../../src/state.js';
import { estimateCostSavings } from '../../src/orchestrator/orchestrator.js';

let g: TestGuard;

before(async () => {
  g = await guardIntegration();
});

describe('Token accumulation integration', () => {
  it('token values survive save/load round-trip', { timeout: 10_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);

    const tmpDir = await mkdtemp(join(tmpdir(), 'tiny-spec-tokens-'));
    try {
      const state = createInitialState('test-feature');

      state.tokenUsage.plannerInput += 1000;
      state.tokenUsage.plannerOutput += 500;
      state.tokenUsage.implementerInput += 2000;
      state.tokenUsage.implementerOutput += 1000;
      state.tokenUsage.escalationInput += 500;
      state.tokenUsage.escalationOutput += 200;

      saveState(tmpDir, state);
      const loaded = loadState(tmpDir);

      assert.ok(loaded, 'Expected state to be loaded');
      assert.equal(loaded.tokenUsage.plannerInput, 1000);
      assert.equal(loaded.tokenUsage.plannerOutput, 500);
      assert.equal(loaded.tokenUsage.implementerInput, 2000);
      assert.equal(loaded.tokenUsage.implementerOutput, 1000);
      assert.equal(loaded.tokenUsage.escalationInput, 500);
      assert.equal(loaded.tokenUsage.escalationOutput, 200);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('estimateCostSavings returns non-zero for combined usage', { timeout: 10_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);

    const savings = estimateCostSavings({
      plannerInput: 1000,
      plannerOutput: 500,
      implementerInput: 2000,
      implementerOutput: 1000,
      escalationInput: 500,
      escalationOutput: 200,
    });

    assert.ok(savings !== '$0.00', `Expected non-zero savings, got ${savings}`);
    assert.ok(savings.startsWith('$'), `Expected savings to start with $, got ${savings}`);
  });
});

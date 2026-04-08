import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardIntegration, type TestGuard } from './guard.js';
import { createInitialState } from '../../src/core/state/machine.js';
import { saveState, loadState } from '../../src/core/state/persistence.js';
import { estimateCostSavings } from '../../src/engine/orchestrator/cost.js';

let g: TestGuard;

beforeAll(async () => {
  g = await guardIntegration();
});

describe('Token accumulation integration', () => {
  it('token values survive save/load round-trip', { timeout: 10_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }

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

      expect(loaded).toBeTruthy();
      if (!loaded) throw new Error('expected loaded state');
      expect(loaded.tokenUsage.plannerInput).toBe(1000);
      expect(loaded.tokenUsage.plannerOutput).toBe(500);
      expect(loaded.tokenUsage.implementerInput).toBe(2000);
      expect(loaded.tokenUsage.implementerOutput).toBe(1000);
      expect(loaded.tokenUsage.escalationInput).toBe(500);
      expect(loaded.tokenUsage.escalationOutput).toBe(200);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('estimateCostSavings returns non-zero for combined usage', { timeout: 10_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }

    const savings = estimateCostSavings({
      plannerInput: 1000,
      plannerOutput: 500,
      implementerInput: 2000,
      implementerOutput: 1000,
      escalationInput: 500,
      escalationOutput: 200,
    });

    expect(savings).not.toBe('$0.00');
    expect(savings.startsWith('$')).toBeTruthy();
  });
});

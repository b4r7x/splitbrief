import { describe, it, expect } from 'vitest';
import { guardIntegration } from './guard.js';
import { withTempDir } from '../helpers/temp-dir.js';
import { createInitialState } from '../../src/core/state/machine.js';
import { saveState, loadState } from '../../src/core/state/persistence.js';
import { calculateCostBreakdown } from '../../src/engine/providers/pricing.js';
import { formatCost } from '../../src/core/formatting.js';

describe('Token accumulation integration', () => {
  it('token values survive save/load round-trip', { timeout: 10_000 }, async (t) => {
    const g = await guardIntegration();
    if (g.skip) { t.skip(); return; }

    await withTempDir('diptych-tokens', async (tmpDir) => {
      const state = createInitialState('test-feature');

      state.tokenUsage.plannerInput += 1000;
      state.tokenUsage.plannerOutput += 500;
      state.tokenUsage.implementerInput += 2000;
      state.tokenUsage.implementerOutput += 1000;
      state.tokenUsage.escalationInput += 500;
      state.tokenUsage.escalationOutput += 200;

      saveState(tmpDir, 'test-session', state);
      const loaded = loadState(tmpDir, 'test-session');

      expect(loaded).toBeTruthy();
      if (!loaded) throw new Error('expected loaded state');
      expect(loaded.tokenUsage.plannerInput).toBe(1000);
      expect(loaded.tokenUsage.plannerOutput).toBe(500);
      expect(loaded.tokenUsage.implementerInput).toBe(2000);
      expect(loaded.tokenUsage.implementerOutput).toBe(1000);
      expect(loaded.tokenUsage.escalationInput).toBe(500);
      expect(loaded.tokenUsage.escalationOutput).toBe(200);
    });
  });

  it('cost breakdown returns non-zero savings for combined usage', { timeout: 10_000 }, async (t) => {
    const g = await guardIntegration();
    if (g.skip) { t.skip(); return; }

    const breakdown = calculateCostBreakdown({
      tokenUsage: {
        plannerInput: 1000,
        plannerOutput: 500,
        implementerInput: 2000,
        implementerOutput: 1000,
        escalationInput: 500,
        escalationOutput: 200,
      },
      totalTasks: 0,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });
    const savings = formatCost(Math.max(0, breakdown.savingsAmount));

    expect(savings).not.toBe('$0.00');
    expect(savings).toMatch(/^\$/);
  });
});

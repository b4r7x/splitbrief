import { describe, it, expect } from 'vitest';
import { ModelsDevModelSchema } from './models-dev.js';

describe('ModelsDevModelSchema pricing', () => {
  it('keeps base pricing, context tiers, and legacy long-context pricing', () => {
    const parsed = ModelsDevModelSchema.parse({
      id: 'gpt-5.4',
      cost: {
        input: 2.5,
        output: 15,
        tiers: [
          { input: 5, output: 22.5, cache_read: 0.5, tier: { type: 'context', size: 272000 } },
        ],
        context_over_200k: { input: 5, output: 22.5 },
      },
    });

    expect(parsed.cost?.input).toBe(2.5);
    expect(parsed.cost?.output).toBe(15);
    expect(parsed.cost?.tiers).toEqual([
      { input: 5, output: 22.5, cache_read: 0.5, tier: { type: 'context', size: 272000 } },
    ]);
    expect(parsed.cost?.context_over_200k).toEqual({ input: 5, output: 22.5 });
  });

  it('parses a model with no cost block', () => {
    const parsed = ModelsDevModelSchema.parse({ id: 'gpt-5-codex' });
    expect(parsed.cost).toBeUndefined();
  });
});

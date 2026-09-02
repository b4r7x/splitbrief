import { describe, it, expect } from 'vitest';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { buildSeatRows, costBar } from './seat-bar.js';
import { resolvePricing } from '../../../engine/providers/pricing-resolver.js';
import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';

const priced = resolvePricing('custom-endpoint', makePricedModelCache(), 'claude-sonnet-5');

const usage = makeUsage({
  plannerInput: 20_000,
  plannerOutput: 4_000,
  implementerInput: 60_000,
  implementerOutput: 12_000,
  escalationInput: 5_000,
  escalationOutput: 1_000,
  reviewerInput: 8_000,
  reviewerOutput: 2_000,
});

describe('buildSeatRows', () => {
  it('gives the reviewer its own row when it holds a seat', () => {
    const rows = buildSeatRows({
      tokenUsage: usage,
      pricingContext: {
        plannerTool: 'claude-code',
        implementerTool: 'codex',
        reviewerTool: 'codex',
      },
      pricing: { planner: priced, implementer: priced, reviewer: priced },
    });

    expect(rows.map((row) => row.seat)).toEqual(['plan', 'build', 'review']);
    const shareTotal = rows.filter((row) => !row.local).reduce((sum, row) => sum + row.share, 0);
    expect(shareTotal).toBeCloseTo(1, 2);
  });

  it('folds the reviewer and the escalation into PLAN when the reviewer has no seat', () => {
    const context = { plannerTool: 'claude-code', implementerTool: 'codex' };
    const pricing = { planner: priced, implementer: priced, reviewer: priced };

    const rows = buildSeatRows({ tokenUsage: usage, pricingContext: context, pricing });
    const plannerOnly = buildSeatRows({
      tokenUsage: makeUsage({
        plannerInput: usage.plannerInput,
        plannerOutput: usage.plannerOutput,
      }),
      pricingContext: context,
      pricing,
    });

    const foldedOnly = buildSeatRows({
      tokenUsage: makeUsage({
        plannerInput: usage.plannerInput,
        plannerOutput: usage.plannerOutput,
        escalationInput: usage.escalationInput,
        escalationOutput: usage.escalationOutput,
        reviewerInput: usage.reviewerInput,
        reviewerOutput: usage.reviewerOutput,
      }),
      pricingContext: context,
      pricing,
    });

    expect(rows.map((row) => row.seat)).toEqual(['plan', 'build']);
    expect(rows[0]?.cost).toBe(foldedOnly[0]?.cost);
    expect(Number((rows[0]?.cost ?? '').replace('$', ''))).toBeGreaterThan(
      Number((plannerOnly[0]?.cost ?? '').replace('$', '')),
    );
  });

  it('marks an unpriced seat as local and leaves it out of the shares', () => {
    const rows = buildSeatRows({
      tokenUsage: usage,
      pricingContext: { plannerTool: 'claude-code', implementerTool: 'ollama' },
      pricing: { planner: priced, implementer: null, reviewer: null },
    });

    const build = rows.find((row) => row.seat === 'build');
    expect(build).toMatchObject({ local: true, cost: 'local', share: 0 });
    expect(rows.find((row) => row.seat === 'plan')?.share).toBeCloseTo(1, 2);
  });

  it('marks a resolved local provider as local rather than free', () => {
    const rows = buildSeatRows({
      tokenUsage: usage,
      pricingContext: { plannerTool: 'claude-code', implementerTool: 'ollama' },
      pricing: {
        planner: priced,
        implementer: resolvePricing('ollama', undefined, 'qwen3'),
        reviewer: null,
      },
    });

    expect(rows.find((row) => row.seat === 'build')).toMatchObject({
      local: true,
      cost: 'local',
      share: 0,
    });
  });
});

describe('costBar', () => {
  it('fills the bar in proportion to the share and pads to the width', () => {
    forceUnicodeGlyphs();

    const bar = costBar({ share: 0.5, width: 10 });

    expect(getTerminalCellWidth(bar)).toBe(10);
    expect(bar.split(glyph('barFilled', 'unicode')).length - 1).toBe(5);
  });

  it('is all padding at share zero and all glyphs at share one', () => {
    expect(costBar({ share: 0, width: 6 }).trim()).toBe('');
    expect(costBar({ share: 1, width: 6 }).trim()).toHaveLength(6);
  });

  it('renders nothing for a negative width', () => {
    expect(costBar({ share: 0.5, width: -4 })).toBe('');
  });
});

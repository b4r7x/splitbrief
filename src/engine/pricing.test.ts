import { describe, it, expect } from 'vitest';
import { getPricing, getPlannerPricing, getImplementerPricing, calculateCost } from './pricing.js';

describe('getPricing', () => {
  it('returns correct pricing for claude-opus-4-6', () => {
    const p = getPricing('claude-opus-4-6');
    expect(p.inputPer1M).toBe(5);
    expect(p.outputPer1M).toBe(25);
    expect(p.isLocal).toBe(false);
  });

  it('returns local pricing for unknown model', () => {
    const p = getPricing('unknown-model');
    expect(p.inputPer1M).toBe(0);
    expect(p.outputPer1M).toBe(0);
    expect(p.isLocal).toBe(true);
  });
});

describe('getPlannerPricing', () => {
  it('returns Opus pricing for claude-code', () => {
    const p = getPlannerPricing('claude-code');
    expect(p.inputPer1M).toBe(5);
    expect(p.outputPer1M).toBe(25);
    expect(p.isLocal).toBe(false);
  });

  it('returns o4-mini pricing for codex', () => {
    const p = getPlannerPricing('codex');
    expect(p.inputPer1M).toBe(0.55);
    expect(p.outputPer1M).toBe(2.2);
    expect(p.isLocal).toBe(false);
  });
});

describe('getImplementerPricing', () => {
  it('returns $0 for ollama (local)', () => {
    const p = getImplementerPricing('ollama');
    expect(p.inputPer1M).toBe(0);
    expect(p.outputPer1M).toBe(0);
    expect(p.isLocal).toBe(true);
  });

  it('returns DeepSeek pricing for deepseek provider', () => {
    const p = getImplementerPricing('deepseek');
    expect(p.inputPer1M).toBe(0.28);
    expect(p.outputPer1M).toBe(0.42);
    expect(p.isLocal).toBe(false);
  });

  it('returns $0 local pricing for unknown provider', () => {
    const p = getImplementerPricing('custom-ollama');
    expect(p.inputPer1M).toBe(0);
    expect(p.outputPer1M).toBe(0);
    expect(p.isLocal).toBe(true);
  });
});

describe('getPlannerPricing for shell', () => {
  it('returns $0 local pricing for shell planner', () => {
    const p = getPlannerPricing('shell');
    expect(p.inputPer1M).toBe(0);
    expect(p.outputPer1M).toBe(0);
    expect(p.isLocal).toBe(true);
  });

  it('returns $0 local pricing for unknown planner tool', () => {
    const p = getPlannerPricing('some-unknown-tool');
    expect(p.inputPer1M).toBe(0);
    expect(p.outputPer1M).toBe(0);
    expect(p.isLocal).toBe(true);
  });
});

describe('calculateCost', () => {
  it('returns correct dollar amount for 1M input + 1M output', () => {
    const pricing = getPricing('claude-opus-4-6');
    const cost = calculateCost(1_000_000, 1_000_000, pricing);
    expect(cost).toBe(30);
  });
});

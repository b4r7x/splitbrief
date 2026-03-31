import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPricing, getPlannerPricing, getImplementerPricing, calculateCost } from '../src/engine/pricing.js';

describe('getPricing', () => {
  it('returns correct pricing for claude-opus-4-6', () => {
    const p = getPricing('claude-opus-4-6');
    assert.equal(p.inputPer1M, 5);
    assert.equal(p.outputPer1M, 25);
    assert.equal(p.isLocal, false);
  });

  it('returns local pricing for unknown model', () => {
    const p = getPricing('unknown-model');
    assert.equal(p.inputPer1M, 0);
    assert.equal(p.outputPer1M, 0);
    assert.equal(p.isLocal, true);
  });
});

describe('getPlannerPricing', () => {
  it('returns Opus pricing for claude-code', () => {
    const p = getPlannerPricing('claude-code');
    assert.equal(p.inputPer1M, 5);
    assert.equal(p.outputPer1M, 25);
    assert.equal(p.isLocal, false);
  });

  it('returns o4-mini pricing for codex', () => {
    const p = getPlannerPricing('codex');
    assert.equal(p.inputPer1M, 1.1);
    assert.equal(p.outputPer1M, 4.4);
    assert.equal(p.isLocal, false);
  });
});

describe('getImplementerPricing', () => {
  it('returns $0 for ollama (local)', () => {
    const p = getImplementerPricing('ollama');
    assert.equal(p.inputPer1M, 0);
    assert.equal(p.outputPer1M, 0);
    assert.equal(p.isLocal, true);
  });

  it('returns DeepSeek pricing for deepseek provider', () => {
    const p = getImplementerPricing('deepseek');
    assert.equal(p.inputPer1M, 0.28);
    assert.equal(p.outputPer1M, 0.42);
    assert.equal(p.isLocal, false);
  });

  it('returns $0 local pricing for unknown provider', () => {
    const p = getImplementerPricing('custom-ollama');
    assert.equal(p.inputPer1M, 0);
    assert.equal(p.outputPer1M, 0);
    assert.equal(p.isLocal, true);
  });
});

describe('getPlannerPricing for shell', () => {
  it('returns $0 local pricing for shell planner', () => {
    const p = getPlannerPricing('shell');
    assert.equal(p.inputPer1M, 0);
    assert.equal(p.outputPer1M, 0);
    assert.equal(p.isLocal, true);
  });

  it('returns $0 local pricing for unknown planner tool', () => {
    const p = getPlannerPricing('some-unknown-tool');
    assert.equal(p.inputPer1M, 0);
    assert.equal(p.outputPer1M, 0);
    assert.equal(p.isLocal, true);
  });
});

describe('calculateCost', () => {
  it('returns correct dollar amount for 1M input + 1M output', () => {
    const pricing = getPricing('claude-opus-4-6');
    const cost = calculateCost(1_000_000, 1_000_000, pricing);
    assert.equal(cost, 30);
  });
});

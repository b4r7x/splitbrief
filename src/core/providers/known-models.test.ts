import { describe, it, expect } from 'vitest';
import { KNOWN_MODELS } from './known-models.js';

describe('KNOWN_MODELS deepseek fallbacks', () => {
  const deepseek = KNOWN_MODELS.deepseek ?? [];
  const chat = deepseek.find((m) => m.name === 'deepseek-chat');
  const reasoner = deepseek.find((m) => m.name === 'deepseek-reasoner');

  it('prices deepseek-chat at the current V4 Flash rate', () => {
    expect(chat?.pricingInput).toBe(0.14);
    expect(chat?.pricingOutput).toBe(0.28);
  });

  it('prices deepseek-reasoner at the same V4 Flash rate', () => {
    expect(reasoner?.pricingInput).toBe(0.14);
    expect(reasoner?.pricingOutput).toBe(0.28);
  });

  it('records the 2026-07-24 alias removal in provenance', () => {
    expect(chat?.provenance).toContain('2026-07-24');
    expect(reasoner?.provenance).toContain('2026-07-24');
  });
});

describe('KNOWN_MODELS agent-sdk entries', () => {
  const agentSdk = KNOWN_MODELS['agent-sdk'] ?? [];

  it('carries no pricing fields (agent-sdk is unpriced-meta, pricing is never served)', () => {
    for (const model of agentSdk) {
      expect(model.pricingInput).toBeUndefined();
      expect(model.pricingOutput).toBeUndefined();
      expect(model.pricingCacheRead).toBeUndefined();
      expect(model.pricingCacheWrite).toBeUndefined();
    }
  });

  it('does not claim cache prices are verified in provenance', () => {
    for (const model of agentSdk) {
      expect(model.provenance ?? '').not.toContain('verified');
    }
  });
});

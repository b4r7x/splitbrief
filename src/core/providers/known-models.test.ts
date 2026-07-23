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

describe('KNOWN_MODELS ollama entries', () => {
  const ollama = KNOWN_MODELS.ollama ?? [];
  const defaultModel = ollama.find((model) => model.isDefault);

  it('uses qwen3-coder:30b with bundled context metadata', () => {
    expect(defaultModel?.name).toBe('qwen3-coder:30b');
    expect(defaultModel?.contextLength).toBe(262_144);
    expect(defaultModel?.provenance).toContain('Ollama library');
    expect(defaultModel?.provenance).toContain('2026-07');
  });
});

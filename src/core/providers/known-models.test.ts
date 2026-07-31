import { describe, it, expect } from 'vitest';
import { KNOWN_MODELS } from './known-models.js';

describe('KNOWN_MODELS DeepSeek V4 defaults', () => {
  const deepseek = KNOWN_MODELS.deepseek ?? [];
  const flash = deepseek.find((m) => m.name === 'deepseek-v4-flash');
  const pro = deepseek.find((m) => m.name === 'deepseek-v4-pro');

  it('defaults to V4 Flash and offers V4 Pro', () => {
    expect(flash?.isDefault).toBe(true);
    expect(pro?.isDefault).toBeUndefined();
    expect(deepseek.map((model) => model.name)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });

  it('records the current context and output ceilings for both V4 models', () => {
    expect(flash).toMatchObject({ contextLength: 1_000_000, maxOutputTokens: 384_000 });
    expect(pro).toMatchObject({ contextLength: 1_000_000, maxOutputTokens: 384_000 });
  });

  it('uses model-specific V4 pricing metadata', () => {
    expect(flash).toMatchObject({ pricingInput: 0.14, pricingOutput: 0.28 });
    expect(pro).toMatchObject({ pricingInput: 0.435, pricingOutput: 0.87 });
  });

  it('does not expose retired aliases as selectable defaults', () => {
    expect(deepseek.some((model) => model.name === 'deepseek-chat')).toBe(false);
    expect(deepseek.some((model) => model.name === 'deepseek-reasoner')).toBe(false);
  });
});

describe('KNOWN_MODELS ollama entries', () => {
  const ollama = KNOWN_MODELS.ollama ?? [];
  const defaultModel = ollama.find((model) => model.isDefault);

  it('keeps the local fallback while leaving its context limit to discovery', () => {
    expect(defaultModel?.name).toBe('qwen3-coder:30b');
    expect(defaultModel?.contextLength).toBeUndefined();
    expect(defaultModel?.provenance).toContain('discovered');
    expect(defaultModel?.provenance).toContain('2026-07');
  });
});

describe('KNOWN_MODELS cheap and local provider metadata', () => {
  it('marks OpenRouter free as an opportunistic non-default', () => {
    const free = KNOWN_MODELS.openrouter?.find((model) => model.name === 'openrouter/free');
    expect(free).toMatchObject({ isFree: true });
    expect(free?.isDefault).toBeUndefined();
    expect(free?.provenance).toContain('opportunistic');
  });

  it('uses the Groq GPT OSS recommendation and its output ceiling', () => {
    const model = KNOWN_MODELS.groq?.find((entry) => entry.isDefault);
    expect(model).toMatchObject({
      name: 'openai/gpt-oss-120b',
      contextLength: 131_072,
      maxOutputTokens: 65_536,
    });
  });

  it('leaves LM Studio context limits to local discovery', () => {
    const model = KNOWN_MODELS['lm-studio']?.find((entry) => entry.isDefault);
    expect(model?.contextLength).toBeUndefined();
    expect(model?.provenance).toContain('discovered');
  });
});

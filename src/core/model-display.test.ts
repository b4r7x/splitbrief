import { describe, it, expect } from 'vitest';
import { formatModelName } from './model-display.js';

describe('formatModelName', () => {
  it('returns empty string for empty input', () => {
    expect(formatModelName('')).toBe('');
  });

  it.each([
    ['opencode-go/glm-5.2', 'GLM 5.2'],
    ['kilo/kilo-auto/free', 'Kilo Auto Free'],
    ['claude-opus-5-thinking-high', 'Claude Opus 5 Thinking High'],
    ['qwen2.5-coder:7b', 'Qwen2.5 Coder 7B'],
    ['gpt-4o', 'GPT-4o'],
  ])('spells an id no provider row names as its pretty name: %s', (id, name) => {
    expect(formatModelName(id)).toBe(name);
  });

  it('keeps the automatic model as its own word, the one the crew identity shows', () => {
    expect(formatModelName('auto')).toBe('auto');
    expect(formatModelName('default', 'claude-code')).toBe('auto');
  });

  it('redacts a credential-shaped id', () => {
    const name = formatModelName('model sk-abcdefghijklmnopqrstuvwxyz');
    expect(name).toContain('***REDACTED***');
    expect(name.toLowerCase()).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('spells a known id with its provider row label', () => {
    expect(formatModelName('claude-opus-5-5', 'claude-code')).toBe('Opus 5.5');
  });

  it('prettifies a namespaced id when no provider is given', () => {
    expect(formatModelName('deepseek/deepseek-flash')).toBe('DeepSeek Flash');
  });
});

describe('formatModelName before any catalog is cached', () => {
  // A cold project names a seat from the bundled rows; a warm one from the tool's own listing.
  // Both must spell the model the way the tool does, or home and the workflow screen disagree.
  it.each([
    ['codex', 'gpt-6-astra', 'GPT-6-Astra'],
    ['codex', 'gpt-6.1-sol', 'GPT-6.1-Sol'],
    ['antigravity', 'gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ])('spells %s %s as the tool lists it', (tool, model, label) => {
    expect(formatModelName(model, tool)).toBe(label);
  });
});

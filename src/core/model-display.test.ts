import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseCursorNativeModelCatalog } from '../engine/providers/cli-model-catalog.js';
import { formatModelName, peelDisplayLabel } from './model-display.js';

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

describe('peelDisplayLabel', () => {
  it.each([
    ['Claude Haiku 5.5 Low No Thinking', 'Claude Haiku 5.5'],
    ['Claude Haiku 5.5  Low No Thinking', 'Claude Haiku 5.5'],
    ['Claude Haiku 5.5 Extra High No Thinking', 'Claude Haiku 5.5'],
    ['Claude Haiku 5.5 Low', 'Claude Haiku 5.5'],
    ['Claude Opus 5 1M Thinking', 'Claude Opus 5'],
    ['GPT-5.5 Extra High', 'GPT-5.5'],
  ])('peels the trailing axis words off %s', (displayName, family) => {
    expect(peelDisplayLabel(displayName)).toBe(family);
  });

  it('peels every name of the cursor-agent 2026.10.22 listing to a clean family name', () => {
    const catalog = parseCursorNativeModelCatalog(
      readFileSync(
        join(import.meta.dirname, '../../testing/fixtures/cursor/list-models-2026.10.22.txt'),
        'utf-8',
      ),
    );
    if (catalog === null) throw new Error('Expected the 2026.10.22 Cursor listing to parse');
    const families = [
      ...new Set(catalog.models.map((model) => peelDisplayLabel(model.displayName ?? ''))),
    ].sort();

    expect(catalog.models).toHaveLength(270);
    expect(families).toEqual([
      'Auto',
      'Claude Fable 5',
      'Claude Fable 5.1',
      'Claude Haiku 5.5',
      'Claude Opus 4.5',
      'Claude Opus 4.6',
      'Claude Opus 4.7',
      'Claude Opus 4.8',
      'Claude Opus 5',
      'Claude Opus 5.5',
      'Claude Sonnet 4',
      'Claude Sonnet 4.5',
      'Claude Sonnet 4.6',
      'Claude Sonnet 5',
      'Claude Sonnet 5.5',
      'Codex 5.3',
      'Composer 2.5',
      'DeepSeek V4.1 Flash 1017',
      'GLM 5.2',
      'GPT-5 Mini',
      'GPT-5.1',
      'GPT-5.2',
      'GPT-5.4',
      'GPT-5.4 Mini',
      'GPT-5.4 Nano',
      'GPT-5.5',
      'GPT-5.6 Luna',
      'GPT-5.6 Sol',
      'GPT-5.6 Terra',
      'Gemini 3 Flash',
      'Gemini 3.1 Pro',
      'Gemini 3.5 Flash',
      'Gemini 3.6 Flash',
      'Gemini 3.7 Flash',
      'Gemini 3.8 Flash',
      'Gemini 4 Argon',
      'Grok 4.5',
      'Grok 4.6',
      'Grok 4.7',
      'Kimi K2.7 Code',
      'Kimi K3',
      'Muse Spark 1.3',
      'Muse Wonder',
    ]);
  });
});

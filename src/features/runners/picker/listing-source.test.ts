import { describe, expect, it } from 'vitest';
import { customModelEntryCopy, pickerListingSource } from './listing-source.js';
import type { ModelOption } from '../model-catalog/recency.js';
import type { RightRow } from '../model-catalog/types.js';

describe('pickerListingSource', () => {
  it('names the listing each tool really has', () => {
    expect(pickerListingSource('copilot')).toEqual({
      source: 'from copilot help config',
      rowNoun: 'model',
      rowNounPlural: 'models',
      unverifiedForPlan: true,
    });
    expect(pickerListingSource('claude-code').rowNounPlural).toBe('aliases');
    expect(pickerListingSource('claude-code').source).not.toContain('--help');
    expect(pickerListingSource('cursor').unverifiedForPlan).toBe(false);
    expect(pickerListingSource('opencode').unverifiedForPlan).toBe(false);
    expect(pickerListingSource('kilo-code').unverifiedForPlan).toBe(false);
    expect(pickerListingSource('codex').unverifiedForPlan).toBe(false);
    expect(pickerListingSource('anthropic')).toEqual({
      source: 'from models.dev',
      rowNoun: 'model',
      rowNounPlural: 'models',
      unverifiedForPlan: true,
    });
    expect(pickerListingSource(undefined)).toEqual(pickerListingSource('anthropic'));
  });
});

describe('customModelEntryCopy', () => {
  const listed = (
    id: string,
    extra: Partial<ModelOption> = {},
  ): Extract<RightRow, { kind: 'model' }> => ({
    kind: 'model',
    model: { id, membership: 'confirmed', ...extra },
    provenance: 'Detected',
    section: '',
    expanded: false,
  });
  const auto = listed('auto', { membership: 'bundled-suggestion' });

  // Ids copied from each tool's own listing fixture under testing/fixtures.
  it.each([
    {
      tool: 'claude-code',
      rows: [
        auto,
        listed('sonnet', { membership: 'bundled-suggestion', catalogModelId: 'claude-sonnet-5' }),
        listed('opus', { membership: 'bundled-suggestion', catalogModelId: 'claude-opus-5-5' }),
        listed('opusplan', { membership: 'bundled-suggestion', catalogModelId: 'claude-opus-5-5' }),
        listed('fable', { membership: 'bundled-suggestion', catalogModelId: 'claude-fable-5-1' }),
      ],
      ids: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1'],
    },
    {
      tool: 'codex',
      rows: [auto, listed('gpt-6-astra'), listed('gpt-6-sol'), listed('gpt-6-luna')],
      ids: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
    },
    {
      tool: 'opencode',
      rows: [
        listed('openrouter/deepseek-v4-flash'),
        listed('openrouter/deepseek-v4-flash-free'),
        listed('anthropic/claude-sonnet-5'),
        listed('openai/gpt-5.6-sol'),
      ],
      ids: ['openrouter/deepseek-v4-flash', 'anthropic/claude-sonnet-5', 'openai/gpt-5.6-sol'],
    },
    {
      tool: 'kilo-code',
      rows: [
        listed('kilo/cohere/north-mini-code:free'),
        listed('kilo/google/lyria-3-pro-preview'),
        listed('github-copilot/gpt-5.5'),
      ],
      ids: ['kilo/cohere/north-mini-code:free', 'github-copilot/gpt-5.5'],
    },
    {
      tool: 'cursor',
      rows: [auto, listed('gpt-5.6-sol-high'), listed('claude-fable-5-high')],
      ids: ['gpt-5.6-sol-high', 'claude-fable-5-high'],
    },
    {
      tool: 'antigravity',
      rows: [listed('gemini-3.8-flash-high'), listed('gemini-3.1-pro-high')],
      ids: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'],
    },
    {
      tool: 'copilot',
      rows: [listed('claude-opus-5'), listed('gpt-5.6-sol')],
      ids: ['claude-opus-5', 'gpt-5.6-sol'],
    },
    {
      tool: 'command-code',
      rows: [listed('deepseek/deepseek-v4-flash'), listed('moonshotai/kimi-k3')],
      ids: ['deepseek/deepseek-v4-flash', 'moonshotai/kimi-k3'],
    },
  ])('offers $tool ids in its own spelling', ({ tool, rows, ids }) => {
    const [first, ...rest] = ids;
    expect(customModelEntryCopy({ rows, toolId: tool })).toEqual({
      placeholder: `e.g. ${first}`,
      examples: rest,
    });
  });

  it('never offers an id the tool did not list', () => {
    const copy = customModelEntryCopy({
      rows: [
        auto,
        listed('llama3.3:latest', { membership: 'custom', isCustom: true }),
        listed('openai/gpt-5.6-sol', { membership: 'catalog-suggestion' }),
        listed('gpt-6-astra'),
      ],
      toolId: 'codex',
    });

    expect(copy).toEqual({ placeholder: 'e.g. gpt-6-astra', examples: [] });
  });

  it('names the command that lists the ids when the listing has not landed', () => {
    expect(customModelEntryCopy({ rows: [auto], toolId: 'kilo-code' })).toEqual({
      placeholder: 'an id from kilo models --verbose',
      examples: [],
    });
  });
});

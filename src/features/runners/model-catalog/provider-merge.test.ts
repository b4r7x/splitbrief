import { describe, expect, it } from 'vitest';
import { mergeProviderVariants } from './provider-merge.js';
import type { ModelOption } from './recency.js';

const ctx = { persistedModel: undefined, customModels: [], providerAuth: undefined };

const openaiLunaFamily: ModelOption = {
  id: 'openai/gpt-5.6-luna',
  displayName: 'GPT-5.6 Luna',
  variants: [
    { fullId: 'openai/gpt-5.6-luna', providerPrefix: '', tag: '' },
    { fullId: 'openai/gpt-5.6-luna-fast', providerPrefix: '', tag: 'Fast' },
  ],
};

describe('mergeProviderVariants', () => {
  it('keeps two models the tool names differently as separate rows', () => {
    const rows = mergeProviderVariants(
      [
        { id: 'kilo/kilo-auto/free', displayName: 'Auto Free' },
        { id: 'kilo/openrouter/free', displayName: 'OpenRouter Free Models Router' },
      ],
      ctx,
    );

    expect(rows.map((row) => row.id)).toEqual(['kilo/kilo-auto/free', 'kilo/openrouter/free']);
    expect(rows.map((row) => row.variants?.map((variant) => variant.tag))).toEqual([
      ['kilo-auto'],
      ['openrouter'],
    ]);
  });

  it('merges two rows the tool names identically', () => {
    const rows = mergeProviderVariants(
      [
        { id: 'kilo/ollama-cloud/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
        { id: 'kilo/opencode-go/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
      ],
      ctx,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'kilo/ollama-cloud/deepseek-v4-flash',
      'kilo/opencode-go/deepseek-v4-flash',
    ]);
  });

  it('merges two unnamed rows that share a bare id', () => {
    const rows = mergeProviderVariants(
      [{ id: 'kilo/ollama-cloud/deepseek-v4-flash' }, { id: 'kilo/opencode-go/deepseek-v4-flash' }],
      ctx,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.variants?.map((variant) => variant.tag)).toEqual([
      'ollama-cloud',
      'opencode-go',
    ]);
  });

  it('merges the same bare id across two route roots', () => {
    const rows = mergeProviderVariants(
      [{ id: 'opencode-go/gpt-5.6-luna' }, { id: 'openai/gpt-5.6-luna' }],
      ctx,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'opencode-go/gpt-5.6-luna',
      'openai/gpt-5.6-luna',
    ]);
    expect(rows[0]?.variants?.map((variant) => variant.tag)).toEqual(['opencode-go', 'openai']);
  });

  it('keeps the option family axis tag and adds the provider tag', () => {
    const rows = mergeProviderVariants(
      [{ id: 'opencode-go/gpt-5.6-luna', displayName: 'GPT-5.6 Luna' }, openaiLunaFamily],
      ctx,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.variants?.map((variant) => variant.tag)).toEqual([
      'opencode-go',
      'openai',
      'openai · Fast',
    ]);
    expect(rows[0]?.variants?.map((variant) => variant.fullId)).toEqual([
      'opencode-go/gpt-5.6-luna',
      'openai/gpt-5.6-luna',
      'openai/gpt-5.6-luna-fast',
    ]);
  });

  it('leaves an unprefixed id out of every group', () => {
    const rows = mergeProviderVariants(
      [{ id: 'gpt-5.6-luna' }, { id: 'openai/gpt-5.6-luna' }],
      ctx,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 'gpt-5.6-luna' });
    expect(rows[1]?.variants?.map((variant) => variant.tag)).toEqual(['openai']);
  });

  it('a differently named pair does not disturb an unrelated row', () => {
    const rows = mergeProviderVariants(
      [
        { id: 'kilo/kilo-auto/free', displayName: 'Auto Free' },
        { id: 'kilo/openrouter/free', displayName: 'OpenRouter Free Models Router' },
        { id: 'kilo/anthropic/claude-opus-4.5' },
      ],
      ctx,
    );

    expect(rows.map((row) => row.id)).toEqual([
      'kilo/kilo-auto/free',
      'kilo/openrouter/free',
      'kilo/anthropic/claude-opus-4.5',
    ]);
    expect(rows[2]?.variants?.map((variant) => variant.tag)).toEqual(['anthropic']);
  });

  it('gives a lone prefixed row a single provider variant', () => {
    const rows = mergeProviderVariants([{ id: 'openai/gpt-5.6-luna' }], ctx);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.variants).toEqual([
      { fullId: 'openai/gpt-5.6-luna', providerPrefix: 'openai', tag: 'openai' },
    ]);
  });
});

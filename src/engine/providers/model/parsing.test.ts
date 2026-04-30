import { describe, expect, it } from 'vitest';
import { parseModelId } from './parsing.js';

describe('parseModelId', () => {
  it('parses provider/model format', () => {
    expect(parseModelId('anthropic/claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelName: 'claude-sonnet-4-6',
    });
  });

  it('infers anthropic from claude prefix', () => {
    expect(parseModelId('claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelName: 'claude-sonnet-4-6',
    });
  });

  it('infers openai from gpt prefix', () => {
    expect(parseModelId('gpt-5.4')).toEqual({
      provider: 'openai',
      modelName: 'gpt-5.4',
    });
  });

  it('returns null provider for unknown models', () => {
    expect(parseModelId('unknown-model-name')).toEqual({
      provider: null,
      modelName: 'unknown-model-name',
    });
  });
});

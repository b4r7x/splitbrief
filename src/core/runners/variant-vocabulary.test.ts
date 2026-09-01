import { describe, expect, it } from 'vitest';
import { variantChoicesForModelId } from './variant-vocabulary.js';

describe('variantChoicesForModelId', () => {
  it('offers the OpenAI preset ladder verbatim', () => {
    expect(variantChoicesForModelId('openai/gpt-5.6-luna')).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('offers only high and max on Anthropic', () => {
    expect(variantChoicesForModelId('anthropic/claude-opus-4-8')).toEqual(['high', 'max']);
  });

  it('offers only low and high on Google', () => {
    expect(variantChoicesForModelId('google/gemini-3.5-pro')).toEqual(['low', 'high']);
  });

  it('offers nothing for a gateway prefix the table does not name', () => {
    expect(variantChoicesForModelId('opencode-go/gpt-5.6-luna')).toEqual([]);
  });

  it('offers nothing for an unprefixed id', () => {
    expect(variantChoicesForModelId('gpt-5.6-luna')).toEqual([]);
  });
});

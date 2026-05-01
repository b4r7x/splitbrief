import { describe, it, expect } from 'vitest';
import { parseModelId } from './parsing.js';

describe('parseModelId', () => {
  it.each([
    ['anthropic/claude-sonnet-4-6', { provider: 'anthropic', modelName: 'claude-sonnet-4-6' }],
    ['claude-sonnet-4-6', { provider: 'anthropic', modelName: 'claude-sonnet-4-6' }],
    ['gpt-5.4', { provider: 'openai', modelName: 'gpt-5.4' }],
    ['unknown-model-name', { provider: null, modelName: 'unknown-model-name' }],
  ] as const)('parses %s', (input, expected) => {
    expect(parseModelId(input)).toEqual(expected);
  });
});

import { describe, expect, it } from 'vitest';
import { EFFORT_AXIS_TOKENS, effortTokenOfModelId } from './effort-channel.js';

describe('EFFORT_AXIS_TOKENS', () => {
  it('spells the effort vocabulary widest to narrowest', () => {
    expect(EFFORT_AXIS_TOKENS).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('effortTokenOfModelId', () => {
  it('reads the effort token off a cursor-shaped id', () => {
    expect(effortTokenOfModelId('claude-opus-4-8-thinking-medium-fast')).toBe('medium');
    expect(effortTokenOfModelId('gpt-5.6-luna-xhigh')).toBe('xhigh');
  });

  it('folds extra-high into xhigh', () => {
    expect(effortTokenOfModelId('gpt-5.5-extra-high-fast')).toBe('xhigh');
  });

  it('reads through a provider prefix', () => {
    expect(effortTokenOfModelId('openai/gpt-5.6-luna-high')).toBe('high');
  });

  it('has no token for an id that spells none', () => {
    expect(effortTokenOfModelId('composer-2.5')).toBeUndefined();
    expect(effortTokenOfModelId('opencode/grok-code-fast')).toBeUndefined();
  });

  it('has no token for undefined', () => {
    expect(effortTokenOfModelId(undefined)).toBeUndefined();
  });
});

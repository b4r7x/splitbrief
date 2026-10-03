import { describe, expect, it } from 'vitest';
import { matchesModelsDevId } from './parsing.js';

describe('matchesModelsDevId', () => {
  it('reads through a window suffix on either side without joining two models', () => {
    expect(matchesModelsDevId({ left: 'claude-fable-5-1[1m]', right: 'claude-fable-5-1' })).toBe(
      true,
    );
    expect(matchesModelsDevId({ left: 'claude-fable-5-1', right: 'claude-fable-5-1[1m]' })).toBe(
      true,
    );
    expect(matchesModelsDevId({ left: 'claude-opus-5[2m]', right: 'claude-opus-5' })).toBe(true);
    expect(matchesModelsDevId({ left: 'claude-opus-5[1M]', right: 'claude-opus-5' })).toBe(true);
    expect(matchesModelsDevId({ left: 'claude-fable-5-1', right: 'claude-fable-5' })).toBe(false);
    expect(matchesModelsDevId({ left: 'claude-opus-5', right: 'claude-opus-4.8' })).toBe(false);
  });
});

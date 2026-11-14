import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configDeclaresFallback } from './run.js';

describe('configDeclaresFallback', () => {
  it('a None config counts no review fallback', () => {
    expect(configDeclaresFallback(makeConfig({ reviewer: 'none' }))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { createOpenAICompatProvider as compatProvider } from './compat.js';
import { createOpenAICompatProvider } from './openai-compat.js';

describe('compat provider entrypoint', () => {
  it('keeps the legacy deep import path available', () => {
    expect(compatProvider).toBe(createOpenAICompatProvider);
  });
});

import { describe, it, expect } from 'vitest';
import { buildContinuationPrompt } from './continuation.js';

describe('buildContinuationPrompt', () => {
  it('includes partial response and user message', () => {
    const result = buildContinuationPrompt('partial output here', 'fix the imports');
    expect(result).toContain('partial output here');
    expect(result).toContain('fix the imports');
    expect(result).toContain('interrupted');
  });

  it('uses default instruction when user message is empty', () => {
    const result = buildContinuationPrompt('partial output', '');
    expect(result).toContain('partial output');
    expect(result).toContain('continue from where you left off');
  });

  it('trims whitespace-only user message to default instruction', () => {
    const result = buildContinuationPrompt('partial', '   ');
    expect(result).toContain('continue from where you left off');
  });
});
